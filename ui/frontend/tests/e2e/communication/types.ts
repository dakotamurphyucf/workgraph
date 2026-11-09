/** Qualification evidence is separate from product state and mutation policy. */
export interface CommunicationWitness {
  readonly scenario: "independent-request-tabs" | "independent-ownership-tabs";
  readonly requirements: readonly ("R04" | "R10" | "R13" | "R14" | "R25")[];
  readonly reads: readonly {
    readonly method: string;
    readonly params: Readonly<Record<string, unknown>>;
    readonly response: Readonly<Record<string, unknown>>;
  }[];
}
