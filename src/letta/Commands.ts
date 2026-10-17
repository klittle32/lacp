/**
 * Letta Code's slash commands as an editor sees them: the built-in commands
 * worth surfacing, and the commands a runtime reports (the built-ins it
 * supports, plus those its mods add).
 */
import type { Command } from "../domain/Events.ts"
import type { DeviceStatus } from "./Protocol.ts"

const BUILTIN = new Map<string, string>([
  ["init", "Set up the agent's memory for this project"],
  ["compact", "Summarize the conversation to free up context"],
  ["reflect", "Reflect on recent work and update memory"],
  ["dream", "Consolidate memory in the background"],
  ["doctor", "Check and repair the agent's memory"],
  ["reload", "Reload mods, skills and settings"],
  ["context-limit", "Show or change the context window limit"],
  ["toolset", "Show or switch the agent's toolset"]
])

/** The built-in commands, for a session that has no runtime yet to report its own. */
export const builtins: ReadonlyArray<Command> = Array.from(BUILTIN, ([name, description]) => ({ name, description }))

/** The commands a runtime reports in its device status. */
export const fromDeviceStatus = (status: DeviceStatus["device_status"]): ReadonlyArray<Command> => [
  ...(status.supported_commands ?? []).flatMap((id): Array<Command> => {
    const description = BUILTIN.get(id)
    return description === undefined ? [] : [{ name: id, description }]
  }),
  ...(status.mod_commands ?? []).map((c): Command => ({
    name: c.id,
    description: c.description,
    ...(c.args === undefined || c.args === null ? {} : { hint: c.args })
  }))
]
