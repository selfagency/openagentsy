#!/usr/bin/env node
import { parseArgs } from "node:util"
import type { Target } from "@openagentsy/core"
import { runBuild } from "./commands/build.js"
import { formatDoctorReport, runDoctor } from "./commands/doctor.js"
import { runModels } from "./commands/models.js"
import { runSetup } from "./commands/setup.js"
import { detectOpenCode, targetForVersion } from "./opencode.js"

const USAGE = `openagentsy <command> [options]

Commands:
  build              Generate the agent, command and skill files for a target OpenCode version
  doctor             Report what is installed, where it came from, and what is missing
  setup              Write the OpenCode config for OpenAgentsy
  models init        Pick a model for every role and write the model lock file
  models refresh     Re-pick the models, show what changed, and write the lock file

Options:
  --root <dir>        Project root (default: current directory)
  --target v1|v2      OpenCode version to generate for (default: detected)
  --out <dir>         Output directory for build (default: <root>/.opencode)
  --roles <file>      Roles file (default: <root>/roles.yaml)
  --lock <file>       Model lock file (default: <root>/openagentsy.models.lock.json)
  --config <file>     Config file for setup (default: <root>/opencode.json)
  --providers <list>  Providers for models init, comma separated
  --allow-training    Allow models whose terms train on prompts
  --allow-retention   Allow models that are not zero data retention
  --key <key>         BenchLM key, for the keyed REST API
  --yes               Write the lock file without asking
  --dry-run           Print what setup would write without writing it
  -h, --help          Show this help
`

async function resolveTarget(explicit: string | undefined): Promise<Target> {
  if (explicit === "v1" || explicit === "v2") return explicit
  const version = await detectOpenCode()
  return version ? targetForVersion(version) : "v1"
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      target: { type: "string" },
      out: { type: "string" },
      roles: { type: "string" },
      lock: { type: "string" },
      config: { type: "string" },
      "dry-run": { type: "boolean" },
      providers: { type: "string" },
      "allow-training": { type: "boolean" },
      "allow-retention": { type: "boolean" },
      key: { type: "string" },
      yes: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  })

  const command = positionals[0]
  const root = values.root ?? process.cwd()

  if (values.help || command === undefined) {
    process.stdout.write(USAGE)
    return command === undefined && !values.help ? 1 : 0
  }

  switch (command) {
    case "build": {
      const target = await resolveTarget(values.target)
      const result = await runBuild({
        root,
        target,
        ...(values.out ? { outDir: values.out } : {}),
        ...(values.roles ? { rolesPath: values.roles } : {}),
        ...(values.lock ? { lockPath: values.lock } : {}),
      })
      process.stdout.write(`built for ${target}\n`)
      process.stdout.write(`  agents   ${result.agents.length}\n`)
      process.stdout.write(`  commands ${result.commands.join(", ")}\n`)
      process.stdout.write(`  skills   ${result.skills.join(", ") || "none"}\n`)
      for (const warning of result.warnings) {
        process.stdout.write(`  warning: ${warning}\n`)
      }
      return 0
    }

    case "doctor": {
      const report = await runDoctor(root)
      process.stdout.write(formatDoctorReport(report))
      return 0
    }

    case "setup": {
      const target = await resolveTarget(values.target)
      const result = await runSetup({
        root,
        target,
        ...(values.config ? { configPath: values.config } : {}),
        ...(values["dry-run"] ? { dryRun: true } : {}),
      })
      process.stdout.write(
        `${result.dryRun ? "would write" : "wrote"} ${result.configPath} for ${target}\n`,
      )
      for (const key of result.changed) {
        process.stdout.write(`  ${key}\n`)
      }
      if (result.pluginPath) {
        process.stdout.write(
          `  ${result.dryRun ? "would install" : "installed"} ${result.pluginPath}\n`,
        )
      } else {
        process.stdout.write("  no plugin bundle found, run: pnpm build\n")
      }
      if (result.dryRun) {
        process.stdout.write("\n")
        process.stdout.write(result.content)
      }
      return 0
    }

    case "models": {
      const sub = positionals[1] ?? "init"
      if (sub !== "init" && sub !== "refresh") {
        process.stderr.write(`unknown models subcommand: ${sub}\n`)
        return 1
      }
      const result = await runModels({
        root,
        providers: values.providers?.split(",") ?? ["opencode-go", "ollama-cloud"],
        ...(values["allow-training"] ? { allowTraining: true } : {}),
        ...(values["allow-retention"] ? { allowRetention: true } : {}),
        ...(values.key ? { key: values.key } : {}),
        ...(values.yes ? { yes: true } : {}),
      })
      process.stdout.write(`model selection for ${result.changes.length} roles\n`)
      for (const change of result.changes) {
        const from = change.from && change.from !== change.to ? `${change.from} -> ` : ""
        process.stdout.write(`  ${change.role.padEnd(12)}${from}${change.to}\n`)
        process.stdout.write(`               ${change.note}\n`)
        for (const rejection of (result.rejected[change.role] ?? []).slice(0, 3)) {
          process.stdout.write(`               not ${rejection.openCodeId}: ${rejection.reason}\n`)
        }
      }
      for (const [role, reason] of Object.entries(result.failures)) {
        process.stdout.write(`  ${role.padEnd(12)}no model available\n`)
        process.stdout.write(`               ${reason}\n`)
      }
      process.stdout.write(
        result.written ? `\nwrote ${result.path}\n` : `\nnot written, pass --yes to write ${result.path}\n`,
      )
      return 0
    }

    default: {
      process.stderr.write(`unknown command: ${command}\n\n`)
      process.stderr.write(USAGE)
      return 1
    }
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
