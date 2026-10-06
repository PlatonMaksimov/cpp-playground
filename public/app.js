const fallback = document.querySelector("#codeFallback");
const input = document.querySelector("#input");
const output = document.querySelector("#output");
const status = document.querySelector("#status");
const exitCode = document.querySelector("#exitCode");
const runButton = document.querySelector("#runButton");
const resetButton = document.querySelector("#resetButton");
const exampleSelect = document.querySelector("#exampleSelect");
const initialCode = fallback.value;
let editor;
const cppHeaders = [
  "algorithm", "array", "atomic", "chrono", "cmath", "cstdint", "cstdio", "cstdlib",
  "cstring", "deque", "fstream", "functional", "future", "iomanip", "iostream",
  "limits", "list", "map", "memory", "mutex", "numeric", "optional", "queue",
  "random", "regex", "set", "sstream", "stack", "string", "thread", "tuple",
  "unordered_map", "unordered_set", "utility", "variant", "vector",
];

const examples = {
  hello: `#include <iostream>

int main() {
    std::cout << "Hello, world!" << std::endl;
    return 0;
}`,
  sum: `#include <iostream>

int main() {
    int a, b;
    std::cin >> a >> b;
    std::cout << a + b << std::endl;
    return 0;
}`,
  stl: `#include <iostream>
#include <vector>
#include <algorithm>

int main() {
    std::vector<int> values{9, 1, 7, 3, 5};
    std::sort(values.begin(), values.end());
    for (int value : values) std::cout << value << " ";
}`,
  lambda: `#include <iostream>
#include <vector>
#include <algorithm>

int main() {
    std::vector<int> values{1, 2, 3, 4, 5};
    std::for_each(values.begin(), values.end(), [](int value) {
        std::cout << value * value << " ";
    });
}`,
};

function getCode() {
  return editor ? editor.getValue() : fallback.value;
}

function setCode(value) {
  if (editor) editor.setValue(value);
  else fallback.value = value;
}

function updateDiagnostics(compilerOutput = "") {
  if (!editor || typeof monaco === "undefined") return;
  const markers = [];
  const pattern = /(?:^|\n).*?main\.cpp:(\d+):(\d+):\s+(fatal error|error|warning|note):\s+([^\n]+)/g;
  let match;
  while ((match = pattern.exec(compilerOutput)) !== null) {
    const line = Number(match[1]);
    const column = Number(match[2]);
    const severity = match[3].includes("error")
      ? monaco.MarkerSeverity.Error
      : match[3] === "warning"
        ? monaco.MarkerSeverity.Warning
        : monaco.MarkerSeverity.Info;
    markers.push({
      startLineNumber: line,
      startColumn: column,
      endLineNumber: line,
      endColumn: column + 1,
      message: match[4],
      severity,
      source: "g++",
    });
  }
  monaco.editor.setModelMarkers(editor.getModel(), "g++", markers);
}

function initializeEditor() {
  if (typeof require !== "function") return;
  self.MonacoEnvironment = {
    getWorkerUrl() {
      return "/monaco-worker.js";
    },
  };
  require.config({ paths: { vs: "/vendor/monaco" } });
  require(["vs/editor/editor.main"], () => {
    editor = monaco.editor.create(document.querySelector("#editor"), {
      value: initialCode,
      language: "cpp",
      theme: "vs-dark",
      automaticLayout: true,
      fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
      fontSize: 14,
      lineHeight: 23,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 14 },
      tabSize: 4,
      insertSpaces: true,
      suggest: { showKeywords: true },
      quickSuggestions: true,
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, runCode);
    monaco.languages.registerCompletionItemProvider("cpp", {
      triggerCharacters: ["<", '"'],
      provideCompletionItems(model, position) {
        const prefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
        const include = prefix.match(/^\s*#\s*include\s*[<"]([^>"]*)$/);
        if (!include) return { suggestions: [] };
        const startColumn = position.column - include[1].length;
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn,
          endColumn: position.column,
        };
        return {
          suggestions: cppHeaders.map((header) => ({
            label: header,
            kind: monaco.languages.CompletionItemKind.File,
            insertText: header,
            range,
            detail: `Стандартный заголовок C++ <${header}>`,
          })),
        };
      },
    });
    fallback.hidden = true;
  });
}

async function runCode() {
  runButton.disabled = true;
  status.textContent = "Компиляция…";
  exitCode.textContent = "";
  output.classList.remove("error");
  output.textContent = "Подождите, программа запускается…";
  updateDiagnostics();

  try {
    const response = await fetch("/api/compile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: getCode(), input: input.value }),
    });
    const result = await response.json();
    const message = result.stderr || result.error;
    updateDiagnostics(result.stderr);
    if (!response.ok) {
      status.textContent = response.status === 429 ? "Лимит запросов" : "Ошибка";
      output.classList.add("error");
      output.textContent = message || "Неизвестная ошибка.";
      return;
    }

    status.textContent = "Готово";
    exitCode.textContent = `exit code: ${result.exitCode}`;
    output.textContent = [result.stdout, result.stderr ? `\n[stderr]\n${result.stderr}` : ""].join("")
      || "(программа ничего не вывела)";
    if (result.stderr || result.exitCode !== 0) output.classList.add("error");
  } catch {
    status.textContent = "Нет связи";
    output.classList.add("error");
    output.textContent = "Сервер не отвечает. Повторите попытку позже.";
  } finally {
    runButton.disabled = false;
  }
}

runButton.addEventListener("click", runCode);
resetButton.addEventListener("click", () => {
  setCode(initialCode);
  input.value = "";
  output.classList.remove("error");
  output.textContent = "Здесь появится вывод программы.";
  status.textContent = "Готово";
  exitCode.textContent = "";
  updateDiagnostics();
  exampleSelect.value = "";
});
exampleSelect.addEventListener("change", () => {
  if (examples[exampleSelect.value]) setCode(examples[exampleSelect.value]);
});
document.addEventListener("keydown", (event) => {
  if (!editor && (event.ctrlKey || event.metaKey) && event.key === "Enter") runCode();
});

initializeEditor();
