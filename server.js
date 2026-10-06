const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const SOCKET_PATH = process.env.SOCKET_PATH || "";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const MONACO_DIR = path.join(ROOT, "node_modules", "monaco-editor", "min", "vs");
const MAX_CODE_SIZE = 100 * 1024;
const MAX_INPUT_SIZE = 20 * 1024;
const MAX_OUTPUT_SIZE = 50 * 1024;
const COMPILE_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS || 2);
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 20);

let activeJobs = 0;
const rateLimits = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function securityHeaders() {
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...securityHeaders(),
    ...extraHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Слишком большой запрос"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientAddress(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0])?.trim()
    || req.socket.remoteAddress
    || "unknown";
}

function checkRateLimit(req) {
  const now = Date.now();
  const key = clientAddress(req);
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  current.count += 1;
  if (current.count > RATE_LIMIT_MAX) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, remaining: RATE_LIMIT_MAX - current.count };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of rateLimits) {
    if (value.resetAt <= now) rateLimits.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function runProcess(command, args, options = {}) {
  const { input = "", timeoutMs, cwd, resourceLimits = false } = options;
  let actualCommand = command;
  let actualArgs = args;

  if (resourceLimits && process.platform !== "win32") {
    actualCommand = "/bin/sh";
    actualArgs = [
      "-c",
      'ulimit -t 4 -v 262144 -f 1024 -n 32; exec "$@"',
      "cpp-runner",
      command,
      ...args,
    ];
  }

  return new Promise((resolve) => {
    const child = spawn(actualCommand, actualArgs, {
      cwd,
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        HOME: cwd,
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputLimitReached = false;

    const terminate = () => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {}
      }
      child.kill("SIGKILL");
    };

    const collect = (target, chunk) => {
      const available = MAX_OUTPUT_SIZE - Buffer.byteLength(target);
      if (available <= 0) {
        outputLimitReached = true;
        terminate();
        return target;
      }
      if (chunk.length > available) {
        outputLimitReached = true;
        terminate();
        return target + chunk.subarray(0, available).toString("utf8");
      }
      return target + chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = collect(stderr, chunk); });

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error, stdout, stderr, timedOut, outputLimitReached, code: null });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, outputLimitReached, code, signal });
    });

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function compilerCandidates() {
  if (process.env.CXX) return [process.env.CXX];
  return process.platform === "win32"
    ? ["g++.exe", "clang++.exe", "g++", "clang++"]
    : ["g++", "clang++"];
}

async function compileAndRun(code, input) {
  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cpp-web-"));
  const source = path.join(workDir, "main.cpp");
  const executable = path.join(workDir, process.platform === "win32" ? "main.exe" : "main");
  await fsp.writeFile(source, code, { encoding: "utf8", mode: 0o600 });

  try {
    let compileResult;
    let compilerName = "";
    for (const command of compilerCandidates()) {
      const result = await runProcess(
        command,
        ["-std=c++17", "-O0", "-pipe", "-pthread", "-Wall", "-Wextra", "-pedantic", source, "-o", executable],
        { cwd: workDir, timeoutMs: COMPILE_TIMEOUT_MS, resourceLimits: true },
      );
      if (!result.error) {
        compileResult = result;
        compilerName = command;
        break;
      }
      compileResult = result;
    }

    if (!compilerName) {
      return {
        ok: false,
        stage: "compiler",
        error: "Компилятор не найден. На сервере должен быть установлен g++ или clang++.",
      };
    }
    if (compileResult.timedOut) {
      return { ok: false, stage: "compile", error: "Компиляция превысила лимит 15 секунд." };
    }
    if (compileResult.outputLimitReached) {
      return { ok: false, stage: "compile", error: "Сообщение компилятора превысило лимит 50 КБ." };
    }
    if (compileResult.code !== 0) {
      return { ok: false, stage: "compile", stderr: compileResult.stderr };
    }

    const runResult = await runProcess(executable, [], {
      cwd: workDir,
      input,
      timeoutMs: RUN_TIMEOUT_MS,
      resourceLimits: true,
    });
    return {
      ok: runResult.code === 0 && !runResult.timedOut && !runResult.outputLimitReached,
      stage: "run",
      compiler: compilerName,
      stdout: runResult.stdout,
      stderr: runResult.stderr,
      exitCode: runResult.code,
      timedOut: runResult.timedOut,
      outputLimitReached: runResult.outputLimitReached,
      error: runResult.timedOut
        ? "Программа превысила лимит выполнения 5 секунд."
        : runResult.outputLimitReached
          ? "Вывод программы превысил лимит 50 КБ."
          : undefined,
    };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true });
  }
}

async function handleCompile(req, res) {
  const rate = checkRateLimit(req);
  if (!rate.allowed) {
    return sendJson(
      res,
      429,
      { error: "Слишком много запусков. Повторите попытку позже." },
      { "Retry-After": String(rate.retryAfter) },
    );
  }
  if (activeJobs >= MAX_CONCURRENT_JOBS) {
    return sendJson(res, 503, { error: "Сервер занят. Повторите попытку через несколько секунд." });
  }

  activeJobs += 1;
  try {
    const raw = await readBody(req, MAX_CODE_SIZE + MAX_INPUT_SIZE + 10_000);
    const payload = JSON.parse(raw);
    const code = typeof payload.code === "string" ? payload.code : "";
    const input = typeof payload.input === "string" ? payload.input : "";

    if (!code.trim()) return sendJson(res, 400, { error: "Введите исходный код C++." });
    if (Buffer.byteLength(code, "utf8") > MAX_CODE_SIZE) {
      return sendJson(res, 413, { error: "Исходный код слишком большой (максимум 100 КБ)." });
    }
    if (Buffer.byteLength(input, "utf8") > MAX_INPUT_SIZE) {
      return sendJson(res, 413, { error: "Входные данные слишком большие (максимум 20 КБ)." });
    }

    const result = await compileAndRun(code, input);
    return sendJson(res, result.ok ? 200 : 422, result, {
      "X-RateLimit-Remaining": String(rate.remaining),
    });
  } catch (error) {
    const status = error.statusCode || (error instanceof SyntaxError ? 400 : 500);
    return sendJson(res, status, {
      error: status === 413 ? error.message : status === 400 ? "Некорректный JSON." : "Не удалось обработать запрос.",
    });
  } finally {
    activeJobs -= 1;
  }
}

function safeStaticPath(baseDir, requestPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const filePath = path.resolve(baseDir, `.${decoded}`);
  return filePath.startsWith(`${baseDir}${path.sep}`) ? filePath : null;
}

function serveFile(req, res, filePath, cacheControl) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500, securityHeaders());
      return res.end("Not found");
    }
    res.writeHead(200, {
      ...securityHeaders(),
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Content-Length": content.length,
      "Cache-Control": cacheControl,
    });
    if (req.method === "HEAD") return res.end();
    res.end(content);
  });
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/vendor/monaco/")) {
    const relative = url.pathname.slice("/vendor/monaco".length);
    const filePath = safeStaticPath(MONACO_DIR, relative);
    if (!filePath) {
      res.writeHead(403, securityHeaders());
      return res.end("Forbidden");
    }
    return serveFile(req, res, filePath, "public, max-age=31536000, immutable");
  }

  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = safeStaticPath(PUBLIC_DIR, requestPath);
  if (!filePath) {
    res.writeHead(403, securityHeaders());
    return res.end("Forbidden");
  }
  return serveFile(req, res, filePath, requestPath === "/index.html" ? "no-cache" : "public, max-age=3600");
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { status: "ok", activeJobs });
  }
  if (req.method === "POST" && req.url === "/api/compile") return void handleCompile(req, res);
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res);
  res.writeHead(405, { ...securityHeaders(), Allow: "GET, HEAD, POST" });
  res.end("Method Not Allowed");
});

server.requestTimeout = 25_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;

function startServer() {
  if (SOCKET_PATH) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    server.listen(SOCKET_PATH, () => {
      fs.chmodSync(SOCKET_PATH, 0o666);
      console.log(`C++ Web Compiler запущен через Unix-сокет: ${SOCKET_PATH}`);
    });
    return;
  }
  server.listen(PORT, HOST, () => {
    console.log(`C++ Web Compiler запущен: http://${HOST}:${PORT}`);
  });
}

startServer();

function shutdown(signal) {
  console.log(`Получен ${signal}, сервер останавливается...`);
  server.close(() => {
    if (SOCKET_PATH) {
      try { fs.unlinkSync(SOCKET_PATH); } catch {}
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
