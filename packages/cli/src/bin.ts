#!/usr/bin/env node
import { main } from "./main.js";
import { nodeEnvironment } from "./node-environment.js";

process.exitCode = await main(process.argv.slice(2), await nodeEnvironment());
