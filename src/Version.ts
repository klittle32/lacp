import pkg from "../package.json" with { type: "json" }

export const VERSION: string = pkg.version

export const AGENT_NAME = "lacp"
export const AGENT_TITLE = "Letta Code"
