#!/usr/bin/env node
/* gitsync.js - GitHub channel helper (zero dependency, ASCII output only).
 *
 * Why this exists:
 *   On this machine github.com:443 is not reachable directly. The proxy in the
 *   environment variables changes between sessions: sometimes the port is dead
 *   (ECONNREFUSED), sometimes it accepts CONNECT but the upstream returns 502.
 *   Plain `git push` then hangs for minutes or fails with "CONNECT tunnel
 *   failed, response 502".
 *
 * What it does:
 *   1. test direct reachability of github.com:443;
 *   2. otherwise probe a few local proxy ports with an HTTP CONNECT request;
 *   3. verify the candidate for real with `git ls-remote`;
 *   4. run the requested git command through the route that actually works.
 *
 * Usage:
 *   node tools/gitsync.js check    probe only, change nothing
 *   node tools/gitsync.js push     probe, then git push  (writes no config)
 *   node tools/gitsync.js fetch    probe, then git fetch
 *   node tools/gitsync.js set      write the working proxy into this repo config
 *   node tools/gitsync.js unset    remove the repo-level proxy config
 *
 * Exit code: 0 ok, 1 nothing usable / git command failed, 2 bad usage.
 */

'use strict';

var http = require('http');
var net = require('net');
var path = require('path');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var HOST = 'github.com';
var PORT = 443;

/* Common local proxy ports: v2rayN mixed/http, xray, Clash, Fiddler, etc.
 * Order matters only for reporting; a port is used only after ls-remote passes. */
var COMMON_PORTS = [10808, 10809, 10807, 50808, 7890, 7891, 1080, 8889, 8080, 20171, 2080, 4780];

var PROXY_ENV = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];

function log(msg) { process.stdout.write(msg + '\n'); }

function cleanEnv() {
  var env = Object.assign({}, process.env);
  for (var i = 0; i < PROXY_ENV.length; i++) delete env[PROXY_ENV[i]];
  env.GIT_TERMINAL_PROMPT = '0';   /* never block on a credential prompt */
  return env;
}

function git(args, opts) {
  var o = Object.assign({ cwd: ROOT, encoding: 'utf8', timeout: 40000, env: cleanEnv() }, opts || {});
  return cp.spawnSync('git', args, o);
}

function proxyArgs(proxy) {
  /* An explicit empty value tells git "no proxy", so a stale repo config
   * cannot hijack the direct attempt. */
  return ['-c', 'http.proxy=' + (proxy || ''), '-c', 'https.proxy=' + (proxy || '')];
}

function repoProxy() {
  var r = git(['config', '--get', 'http.proxy'], { timeout: 8000 });
  var v = (r.stdout || '').trim();
  return v || '';
}

function portOf(url) {
  var m = /^[a-z]+:\/\/(?:[^@\/]+@)?([^:\/]+)(?::(\d+))?/i.exec(url || '');
  if (!m) return 0;
  if (m[2]) return parseInt(m[2], 10);
  return /^https$/i.test(/^([a-z]+):/i.exec(url)[1]) ? 443 : 80;
}

function envPorts() {
  var out = [];
  for (var i = 0; i < PROXY_ENV.length; i++) {
    var v = process.env[PROXY_ENV[i]];
    if (!v) continue;
    var p = portOf(v);
    if (p > 0 && p < 65536 && out.indexOf(p) < 0) out.push(p);
  }
  return out;
}

function candidatePorts() {
  var out = [];
  function add(p) { if (p > 0 && p < 65536 && out.indexOf(p) < 0) out.push(p); }
  add(portOf(repoProxy()));
  envPorts().forEach(add);
  COMMON_PORTS.forEach(add);
  return out;
}

function tcpDirect(ms) {
  return new Promise(function (resolve) {
    var s = net.connect({ host: HOST, port: PORT });
    var done = false;
    function fin(ok) { if (done) return; done = true; s.destroy(); resolve(ok); }
    s.setTimeout(ms, function () { fin(false); });
    s.on('connect', function () { fin(true); });
    s.on('error', function () { fin(false); });
  });
}

function connectProbe(port, ms) {
  return new Promise(function (resolve) {
    var req = http.request({ host: '127.0.0.1', port: port, method: 'CONNECT', path: HOST + ':' + PORT, timeout: ms });
    var done = false;
    function fin(res) { if (done) return; done = true; try { req.destroy(); } catch (e) {} resolve(res); }
    req.on('connect', function (res, sock) { try { sock.destroy(); } catch (e) {} fin({ code: res.statusCode }); });
    req.on('timeout', function () { fin({ err: 'timeout' }); });
    req.on('error', function (e) { fin({ err: e.code || e.message }); });
    req.end();
  });
}

/* Real proof: only a successful ls-remote proves the route reaches GitHub. */
function verify(proxy, ms) {
  var r = git(proxyArgs(proxy).concat(['ls-remote', '--heads', 'origin', 'main']), { timeout: ms || 25000 });
  if (r.status !== 0) return { ok: false, err: (r.stderr || '').split('\n')[0] || 'exit ' + r.status };
  var line = (r.stdout || '').split('\n').filter(Boolean)[0] || '';
  var sha = line.split(/\s+/)[0] || '';
  return { ok: true, sha: sha };
}

/* Proxies here are residential/VPS links that occasionally drop a single TLS
 * handshake ("schannel: failed to receive handshake"). One failure is not proof
 * that the route is dead, so retry before discarding a candidate. */
function verifyRetry(proxy, tries, ms) {
  var last = null;
  var n = tries || 2;
  for (var i = 0; i < n; i++) {
    last = verify(proxy, ms);
    if (last.ok) return last;
  }
  return last;
}

function probeAll() {
  return tcpDirect(5000).then(function (directOk) {
    log('[1/2] direct ' + HOST + ':' + PORT + ' ... ' + (directOk ? 'reachable' : 'blocked'));
    if (directOk) {
      var vd = verifyRetry(null, 2, 15000);
      if (vd.ok) return { proxy: null, via: 'direct', sha: vd.sha };
      log('      direct handshake failed (' + vd.err + '), falling back to proxy');
    }
    var ports = candidatePorts();
    log('[2/2] probing ' + ports.length + ' local proxy port(s) ...');
    var i = 0;
    function next() {
      if (i >= ports.length) return Promise.resolve(null);
      var p = ports[i++];
      return connectProbe(p, 4000).then(function (r) {
        if (r.err) { log('      127.0.0.1:' + p + ' ... ' + r.err); return next(); }
        if (r.code !== 200) { log('      127.0.0.1:' + p + ' ... CONNECT ' + r.code + ' (not a proxy)'); return next(); }
        var url = 'http://127.0.0.1:' + p;
        var v = verifyRetry(url, 2);
        if (!v.ok) { log('      127.0.0.1:' + p + ' ... CONNECT 200 but ls-remote failed: ' + v.err); return next(); }
        log('      127.0.0.1:' + p + ' ... CONNECT 200, ls-remote OK');
        return { proxy: url, via: String(p), sha: v.sha };
      });
    }
    return next();
  });
}

function runGit(route, args) {
  var full = proxyArgs(route.proxy).concat(args);
  log('\n$ git ' + full.join(' '));
  var r = cp.spawnSync('git', full, { cwd: ROOT, stdio: 'inherit', env: cleanEnv() });
  if (r.error) { log('ERROR: ' + r.error.message); return 1; }
  log('\ngit exit code: ' + r.status);
  return r.status === 0 ? 0 : 1;
}

function main() {
  var cmd = (process.argv[2] || 'check').toLowerCase();
  var extra = process.argv.slice(3);

  if (cmd === 'unset') {
    var ru = git(['config', '--local', '--unset', 'http.proxy']);
    log(ru.status === 0 ? 'repo-level http.proxy removed' : 'no repo-level http.proxy to remove');
    return 0;
  }

  if (['check', 'push', 'fetch', 'set'].indexOf(cmd) < 0) {
    log('usage: node tools/gitsync.js [check|push|fetch|set|unset] [git args...]');
    return 2;
  }

  probeAll().then(function (route) {
    if (!route) {
      log('\nRESULT: no usable route to ' + HOST + '.');
      log('Hint: start the proxy client (v2rayN/xray) and make sure its inbound port is');
      log('      listening; then run this again.');
      return 1;
    }
    log('\nRESULT: route = ' + (route.proxy || 'direct') + (route.sha ? '  (origin/main=' + route.sha.slice(0, 7) + ')' : ''));

    if (cmd === 'check') {
      if (route.proxy) log('To make plain "git push" work in this repo, run: node tools/gitsync.js set');
      return 0;
    }
    if (cmd === 'set') {
      if (!route.proxy) {
        /* Direct works: keep the repo clean instead of writing an empty
         * http.proxy, which would also mask a working env proxy later. */
        git(['config', '--local', '--unset', 'http.proxy']);
        log('direct route works; repo-level http.proxy left unset');
        return 0;
      }
      var rs = git(['config', '--local', 'http.proxy', route.proxy]);
      log(rs.status === 0 ? 'repo-level http.proxy = ' + route.proxy : 'failed to write git config');
      return rs.status === 0 ? 0 : 1;
    }
    var args = cmd === 'push' ? ['push', 'origin', 'main'].concat(extra) : ['fetch', 'origin', '--prune'].concat(extra);
    return runGit(route, args);
  }).then(function (code) {
    process.exitCode = code;
    if (code === 0) log('DONE');
  }).catch(function (e) {
    log('ERROR: ' + (e && e.stack || e));
    process.exitCode = 1;
  });
}

if (require.main === module) main();

/* Exported for ad-hoc checks (e.g. verifying one proxy without running a push). */
module.exports = {
  ROOT: ROOT,
  candidatePorts: candidatePorts,
  portOf: portOf,
  connectProbe: connectProbe,
  tcpDirect: tcpDirect,
  verify: verify,
  verifyRetry: verifyRetry,
  probeAll: probeAll
};
