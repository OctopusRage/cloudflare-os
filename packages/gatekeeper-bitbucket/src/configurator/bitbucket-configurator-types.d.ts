export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type BitbucketRepositoryConfiguratorValues = {
  /** `workspace/repo-slug`. */
  fullName?: string | null;
}

export type BitbucketPullRequestConfiguratorValues = {
  fullName?: string | null;
  /** The pull request number, as a string. */
  pullRequestId?: string | null;
}

export interface BitbucketConfiguratorRpc {
  /** Repositories the connected user can read whose name matches `query`, or the one a URL or `workspace/repo` names. */
  listRepositories(query: string): Promise<ConfiguratorOption[]>;
  /** Pull requests of `fullName` matching `query` (a title fragment or a number). */
  listPullRequests(fullName: string, query: string): Promise<ConfiguratorOption[]>;
}
