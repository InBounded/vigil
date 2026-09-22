export class NotASquadsMultisigError extends Error {
  constructor(address: string) {
    super(
      `${address} is not a Squads v4 multisig. If you pasted the vault address, use the ` +
        "multisig address instead, shown in Squads settings.",
    );
    this.name = "NotASquadsMultisigError";
  }
}

export class MultisigAccountNotFoundError extends Error {
  constructor(address: string) {
    super(`No account was found at ${address}.`);
    this.name = "MultisigAccountNotFoundError";
  }
}
