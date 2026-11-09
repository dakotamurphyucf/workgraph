/** Hash the regular frontend source/config/lock and build-tool inputs. */
export function frontendInputHash(projectRoot: string): string;
export function regularFilesUnder(dir: string): string[];
/** Require the actual Vite output stamp and reject changed/missing inputs. */
export function readBuildStamp(projectRoot: string): {
  schema_version: 1;
  input_sha256: string;
};
