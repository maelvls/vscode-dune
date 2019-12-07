"use strict";

import * as vscode from "vscode";
import * as child_process from "child_process";
import { log } from "util";

const compareVersions = require("compare-versions");

let getStream = require("get-stream");
let configuration = vscode.workspace.getConfiguration("dune");
let language = "sat";
let enabled = configuration.get<boolean>("enableLint");
let version = "";
let status = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right,
  0
);

export async function activate(context: vscode.ExtensionContext) {
  child_process.exec(
    `${configuration.get<string>("path")} --version`,
    (err, stdout) => {
      if (err) {
        let ret = vscode.window
          .showWarningMessage(
            `Could not find '${configuration.get<string>("path")}'
                binary. Linter will be disabled for now.`,
            "Always disable linter"
          )
          .then(ret => {
            if (ret === "Always disable linter")
              configuration.update("enableLint", false, true);
          });
        enabled = false;
        return;
      }
    }
  );

  if (!enabled) return;

  let toVsPos = pos => {
    return new vscode.Position(pos.line - 1, pos.col - 1);
  };
  let fromVsPos = (pos: vscode.Position) => {
    return { line: pos.line + 1, col: pos.character + 1 };
  };
  let toVsRange = (start, end) => {
    return new vscode.Range(toVsPos(start), toVsPos(end));
  };
  let provideLinter = async (document: vscode.TextDocument, token) => {
    if (
      !enabled ||
      token.isCancellationRequested ||
      !configuration.get<boolean>("enableLint")
    )
      return null;
    let path = configuration.get<string>("path");
    let cmd = [path];
    log("cmd: " + cmd.join(" "));
    let cp = child_process.spawn(cmd[0], cmd.slice(1), {});

    cp.on("error", err => {
      let ret = vscode.window
        .showInformationMessage(`'${cmd[0]}' not found in path.`, "Disable")
        .then(ret => {
          if (ret === "Disable") {
            configuration.update("enableLint", false, true);
          }
        });
    });
    cp.on("exit", (code: number, sig) => {
      log("dune returned " + code + ", signal: " + sig);
      switch (code) {
        case 124:
          return vscode.window.showInformationMessage(
            "tell the developer: wrong 'dune' command: " + cmd.join(" ")
          );
      }
    });

    cp.stdin.write(document.getText());
    cp.stdin.end();

    let stderr = await getStream(cp.stderr).catch(err => {
      log(err);
      vscode.window.showWarningMessage("dune error: " + err);
      return "";
    });

    cp.unref();

    let handle_stderr = (stderr): vscode.Diagnostic[] => {
      let diagnostics: vscode.Diagnostic[] = [];
      log("stderr: " + stderr);
      let fromType = type => {
        switch (type) {
          case "error":
            return vscode.DiagnosticSeverity.Error;
          case "warning":
            return vscode.DiagnosticSeverity.Warning;
        }
      };
      let regex = /^([^:]+): line (\d+)-(\d+), col (\d+)-(\d+): (error|warning): (.*)$/gm;
      let pushDiag = (
        file,
        line1: number,
        line2: number,
        col1: number,
        col2: number,
        type,
        msg
      ) => {
        let diag = new vscode.Diagnostic(
          toVsRange({ line: line1, col: col1 }, { line: line2, col: col2 }),
          msg,
          fromType(type.toLowerCase())
        );
        diag.source = "dune";
        diagnostics.push(diag);
      };

      let msg = "";
      let file, row1, row2, col1, col2, type;
      stderr.split("\n").forEach(line => {
        let match = regex.exec(line);
        if (match !== null) {
          if (msg !== "") pushDiag(file, row1, row2, col1, col2, type, msg);
          file = match[1];
          row1 = +match[2];
          row2 = +match[3];
          col1 = +match[4];
          col2 = +match[5];
          type = match[6];
          msg = match[7];
        } else {
          msg += line === "" ? "" : "\n" + line;
        }
      });
      if (msg !== "") pushDiag(file, row1, row2, col1, col2, type, msg.trim());
      return diagnostics;
    };

    return handle_stderr(stderr);
  };

  let LINTER_DEBOUNCE_TIMER = new WeakMap();
  let LINTER_TOKEN_SOURCE = new WeakMap();
  let LINTER_CLEAR_LISTENER = new WeakMap();

  let diagnosticCollection = vscode.languages.createDiagnosticCollection(
    "dune"
  );

  let lintDocument = async (document: vscode.TextDocument) => {
    if (document.languageId !== "dune") return;

    clearTimeout(LINTER_DEBOUNCE_TIMER.get(document));
    LINTER_DEBOUNCE_TIMER.set(
      document,
      setTimeout(async () => {
        if (LINTER_TOKEN_SOURCE.has(document)) {
          LINTER_TOKEN_SOURCE.get(document).cancel();
        }
        LINTER_TOKEN_SOURCE.set(document, new vscode.CancellationTokenSource());

        let diagnostics = await provideLinter(
          document,
          LINTER_TOKEN_SOURCE.get(document).token
        );
        diagnosticCollection.set(document.uri, diagnostics);
      }, configuration.get<number>("lintDelay"))
    );
  };

  vscode.workspace.onDidSaveTextDocument(async document => {
    if (
      !enabled ||
      !configuration.get<boolean>("lintOnSave") ||
      configuration.get<boolean>("lintOnChange") ||
      document.languageId !== "dune"
    )
      return;
    let diagnostics = await provideLinter(
      document,
      new vscode.CancellationTokenSource().token
    );
    diagnosticCollection.set(document.uri, diagnostics);
  });

  vscode.workspace.onDidOpenTextDocument(async document => {
    if (
      !enabled ||
      !configuration.get<boolean>("lintOnSave") ||
      document.languageId !== "dune"
    )
      return;
    let diagnostics = await provideLinter(
      document,
      new vscode.CancellationTokenSource().token
    );
    diagnosticCollection.set(document.uri, diagnostics);
  });

  vscode.workspace.onDidChangeTextDocument(async ({ document }) => {
    if (!enabled || !configuration.get<boolean>("lintOnChange")) return;

    if (document.languageId === "dune") {
      lintDocument(document);
      return;
    }
  });

  vscode.workspace.onDidCloseTextDocument(document => {
    if (document.languageId === "dune") {
      diagnosticCollection.delete(document.uri);
    }
  });
}

export function deactivate() {}
