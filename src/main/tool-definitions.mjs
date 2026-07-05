/**
 * Model-facing tool definitions exposed by agent-tool.
 *
 * This file contains the public tool schemas that are advertised through the
 * tool manifest. Runtime implementations live in sibling modules; keeping the
 * schemas here makes the model contract easy to audit without following the
 * execution code.
 */

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

export const SKILL_FIND_TOOL = {
  name: "skill_find",
  description: "Find available skills from the injected agent-skill index without loading full SKILL.md content.",
  schema: {
    type: "function",
    function: {
      name: "skill_find",
      description: "Find available skills by text query, capability, or required tool.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional text query matched against skill name, description, capabilities, and tool requirements."
          },
          capability: {
            type: "string",
            description: "Optional capability id to match exactly."
          },
          requiredTool: {
            type: "string",
            description: "Optional required or optional tool name to match exactly."
          },
          includeDisabled: {
            type: "boolean",
            description: "Include disabled skills in the result. Defaults to false."
          },
          limit: {
            type: "integer",
            minimum: 1,
            description: "Maximum number of skills to return."
          }
        }
      }
    }
  },
  permissions: ["skill.index.read"],
  timeoutMs: 5_000,
  cancelable: false
};

export const SKILL_ACTIVATE_TOOL = {
  name: "skill_activate",
  description: "Load a selected skill's SKILL.md content from the injected agent-skill index for CLI-managed context activation.",
  schema: {
    type: "function",
    function: {
      name: "skill_activate",
      description: "Activate a skill by id or name and return a loadedSkill payload for the orchestrator.",
      parameters: {
        type: "object",
        required: ["skill"],
        properties: {
          skill: {
            type: "string",
            description: "Skill id or name from skill_find."
          }
        }
      }
    }
  },
  permissions: ["skill.content.read"],
  timeoutMs: 5_000,
  cancelable: false
};

export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description: "Search current public web information through the configured Tavily or generic web gateway provider.",
  schema: {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web through the configured provider.",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "Search query."
          },
          maxResults: {
            type: "integer",
            minimum: 1,
            description: "Optional maximum results override."
          }
        }
      }
    }
  },
  permissions: ["network.web.search"],
  timeoutMs: 20_000,
  cancelable: true
};

export const WEB_FETCH_TOOL = {
  name: "web_fetch",
  description: "Fetch readable content from an exact public http:// or https:// URL through the configured web provider.",
  schema: {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch readable content from an exact URL.",
      parameters: {
        type: "object",
        required: ["url"],
        properties: {
          url: {
            type: "string",
            description: "Exact http:// or https:// URL supplied by the user or returned by web_search/web_fetch."
          }
        }
      }
    }
  },
  permissions: ["network.web.fetch"],
  timeoutMs: 20_000,
  cancelable: true
};
