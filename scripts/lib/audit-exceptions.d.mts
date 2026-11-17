export interface AuditException {
  ids: string[];
  package?: string;
  expires: string;
  ref: string;
  reason: string;
}

export declare function loadExceptions(path?: string | URL): AuditException[];

export declare function activeException(
  exceptions: AuditException[],
  ids: string[],
  today?: string,
): AuditException | undefined;
