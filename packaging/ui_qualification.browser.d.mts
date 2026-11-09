/** External qualification only. Does not run inside the installed companion. */
export interface InstalledBrowserInput {
  readonly playwrightModule: string;
  readonly executable: string;
  readonly url: string;
  readonly phase: "create" | "restart" | "reinstall";
  readonly output: string;
}
export interface InstalledBrowserResult {
  readonly browserVersion: string;
  readonly phase: InstalledBrowserInput["phase"];
  readonly observedTicketId: "installed-browser-ticket";
  readonly failures: readonly string[];
  readonly requests: readonly {
    readonly method: string;
    readonly url: string;
    readonly postDataSha256: string | null;
  }[];
}
