/**
 * Node-only entry point (`@vigil-sol/core/node`): helpers that read files from disk. Kept out of
 * the main entry so a browser bundle of `@vigil-sol/core` never pulls in a Node built-in module.
 */
export { loadFixtureFile, loadFixtureFiles } from "./rpc/fixture-file.js";
