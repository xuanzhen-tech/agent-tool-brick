export const RUN_SHELL_TOOL = {
  name: "run_shell",
  description: [
    "Execute a focused terminal command in the current workspace with timeout, cancel, and output-size limits.",
    "Prefer mode='process' for Python, Node, git, npm, npx, and scripts because executable, args, and stdin are passed without shell quoting.",
    "Use mode='shell' only for shell-specific syntax such as PowerShell pipelines, variables, redirection, and conditional execution.",
    "Do not perform destructive file operations unless the user explicitly requested them and the target path has been verified."
  ].join(" "),
  schema: {
    type: "function",
    function: {
      name: "run_shell",
      description: "Execute a focused terminal command in the current workspace with timeout, cancel, and output limits.",
      parameters: {
        type: "object",
        properties: {
          mode: {
            type: "string",
            enum: ["process", "shell"],
            description: "Execution mode. Use process for argv/stdin, shell for PowerShell or shell syntax."
          },
          command: {
            type: "string",
            description: "Shell command for mode=shell."
          },
          executable: {
            type: "string",
            description: "Executable for mode=process, for example node, python, git, npm, or npx."
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Argument vector for mode=process."
          },
          stdin: {
            type: "string",
            description: "Optional stdin for mode=process."
          },
          timeoutMs: {
            type: "integer",
            minimum: 1,
            description: "Optional timeout override in milliseconds."
          }
        }
      }
    }
  },
  permissions: ["process.exec"],
  timeoutMs: 20_000,
  cancelable: true
};

export const WORKSPACE_SEARCH_TOOL = {
  name: "workspace_search",
  description: "Search text inside the current workspace through the injected rg tool runtime.",
  schema: {
    type: "function",
    function: {
      name: "workspace_search",
      description: "Search text inside the current workspace.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Text or regex pattern to search for."
          },
          path: {
            type: "string",
            description: "Workspace-relative file or directory path. Defaults to the workspace root."
          },
          glob: {
            type: "string",
            description: "Optional rg glob, for example **/*.md."
          },
          maxMatches: {
            type: "integer",
            minimum: 1,
            description: "Maximum matching lines to return."
          }
        }
      }
    }
  },
  permissions: ["workspace.read"],
  timeoutMs: 30_000,
  cancelable: true
};
