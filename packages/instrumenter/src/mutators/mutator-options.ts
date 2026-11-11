export interface TypeAwareMutatorOptions {
  enabled: boolean;
  maxCandidatesPerSite: number;
}

export interface MutatorOptions {
  excludedMutations: string[];
  noHeader?: boolean;
  /** Experimental type-aware mutators, based on the TypeScript type checker */
  typeAware?: TypeAwareMutatorOptions;
  /** The tsconfig file to build the TypeScript program from, used for type-aware mutation */
  tsconfigFile?: string;
}
