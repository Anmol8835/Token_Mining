// ============================================================
// Code grader — lightweight subprocess test runner (no Docker)
//
// Two auto-detected harnesses:
//   - unittest (BigCodeBench): test field is a unittest.TestCase
//     class calling task_func() directly.
//   - check(candidate) (HumanEval-Plus): test field defines
//     check(candidate) — wrap, exec, call.
// ============================================================

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TIMEOUT_MS = 60000;

// Prefer the benchmark venv's python (it has numpy/scipy/faker etc.
// installed for tests); fall back to system python3.
const VENV_PY = path.join(__dirname, "..", ".venv", "bin", "python");
const PYTHON = fs.existsSync(VENV_PY) ? VENV_PY : "python3";

/** Detect the harness format from the test source. */
function detectHarness(testSource) {
  if (/def\s+check\s*\(/.test(testSource)) return "check";
  if (/unittest|TestCase/.test(testSource)) return "unittest";
  return "unknown";
}

function runPython(filePath) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    const child = spawn(PYTHON, ["-u", filePath], {
      cwd: path.dirname(filePath),
      timeout: TIMEOUT_MS,
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => resolve({ exitCode: -1, stdout, stderr, error: err.message, ms: Date.now() - started }));
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr, ms: Date.now() - started }));
  });
}

/**
 * Run candidate code against a task's tests.
 * @returns {{pass, exit_code, output_snippet, error}}
 */
async function runCodeTests({ candidateCode, testSource, entryPoint, taskId }) {
  const tmpFile = path.join(os.tmpdir(), `bench-${String(taskId).replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now()}.py`);
  const harness = detectHarness(testSource);
  let script;

  if (harness === "unittest") {
    script = `${candidateCode}

${testSource}

if __name__ == "__main__":
    import unittest
    unittest.main(verbosity=0)
`;
  } else if (harness === "check") {
    script = `import sys
candidate_globals = {}
candidate_code = ${JSON.stringify(candidateCode)}
exec(candidate_code, candidate_globals)
fn = candidate_globals.get(${JSON.stringify(entryPoint)})
if fn is None:
    print("ENTRYPOINT_MISSING", file=sys.stderr)
    sys.exit(2)
test_globals = candidate_globals.copy()
exec(${JSON.stringify(testSource)}, test_globals)
check_fn = test_globals.get("check")
if check_fn is None:
    print("NO_CHECK_FUNCTION", file=sys.stderr)
    sys.exit(2)
check_fn(fn)
print("PASS")
`;
  } else {
    return { pass: false, exit_code: -1, output_snippet: "unknown harness", error: "unknown harness format" };
  }

  try {
    fs.writeFileSync(tmpFile, script);
    const r = await runPython(tmpFile);
    const pass =
      harness === "unittest" ? r.exitCode === 0 : r.exitCode === 0 && /PASS/.test(r.stdout);
    return {
      pass,
      exit_code: r.exitCode,
      output_snippet: (r.stdout + r.stderr).slice(0, 300) || null,
      error: r.error || null,
    };
  } catch (err) {
    return { pass: false, exit_code: -1, output_snippet: null, error: err.message };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

module.exports = { runCodeTests, detectHarness };
