export interface BacklogTask {
  id: string;
  module: string;
  status: string;
  prd_ids: string[];
  supports?: string[];
}

export interface CoverageInput {
  prd: string;
  index: string;
  modules: string;
  backlog: { tasks: BacklogTask[] };
  testIds: ReadonlySet<string>;
}

export interface CoverageResult {
  indexed: number;
  owned: number;
  unmapped: number;
  outsideModule: number;
  failures: string[];
}

export function prdIds(prd: string): Set<string>;
export function indexIds(index: string): Set<string>;
export function moduleOwners(modules: string): {
  owners: Map<string, string[]>;
  byModule: Map<string, Set<string>>;
  unmappedNone: boolean;
};
export function testTitleIds(source: string): Set<string>;
export function checkCoverage(input: CoverageInput): CoverageResult;
