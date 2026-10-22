#!/usr/bin/env node
import { parseArgs } from "node:util"
import type { Target } from "@openagentsy/core"
import { runBuild } from "./commands/build.js"
import { formatDoctorReport, runDoctor } from "./commands/doctor.js"
import { runSetup } from "./commands/setup.js"
import { detectOpenCode, targetForVersion } from "./opencode.js"

const USAGE = `openagentsy <command> [options]

Commands:
  build     Generate the agent, command and skill files for a target OpenCode version
  doctor    Report what is installed, where it came from, and what is missing
  setup     Write the OpenCode config for OpenAgentsy

Options:
  --root <dir>        Project root (default: current directory)
  --target v1|v2      OpenCode version to generate for (default: detected)
  --out <dir>         Output directory for build (default: <root>/.opencode)
  --roles <file>      Roles file (default: <root>/roles.yaml)
  --lock <file>       Model lock file (default: <root>/openagentsy.models.lock.json)
  --config <file>     Config file for setup (default: <root>/opencode.json)
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
      if (result.dryRun) {
        process.stdout.write("\n")
        process.stdout.write(result.content)
      }
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
