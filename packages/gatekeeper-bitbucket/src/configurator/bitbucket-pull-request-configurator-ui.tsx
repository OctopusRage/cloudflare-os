import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { BitbucketConfiguratorRpc, BitbucketPullRequestConfiguratorValues } from "./bitbucket-configurator-types";

const ORIGIN = "https://bitbucket.org";

/** The repository and pull request number a bitbucket.org pull request link names, or null. */
function parsePullRequestUrl(resourceUrl: string): BitbucketPullRequestConfiguratorValues | null {
  try {
    const url = new URL(resourceUrl);
    if (url.origin !== ORIGIN) return null;
    const [workspace, repo, section, id] = url.pathname.split("/").filter(Boolean);
    if (!workspace || !repo) return null;
    const fullName = `${workspace}/${repo.replace(/\.git$/, "")}`;
    return section === "pull-requests" && id && /^\d+$/.test(id) ? { fullName, pullRequestId: id } : { fullName };
  } catch {
    return null;
  }
}

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.fullName === "string" && values.fullName.includes("/") &&
      typeof values.pullRequestId === "string" && /^\d+$/.test(values.pullRequestId);
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    return parsePullRequestUrl(resourceUrl) ?? {};
  },

  async resourceUrl({ values }) {
    return `${ORIGIN}/${values.fullName}/pull-requests/${values.pullRequestId}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Repository" description="Search your repositories, or paste a Bitbucket repository URL or workspace/repo.">
        <Autocomplete
          name="fullName"
          value={values.fullName}
          placeholder="Search or paste a repository URL..."
          loadOptions={query => ui.listRepositories(query)}
          onChange={fullName => setValues({ fullName, pullRequestId: null })}
        />
      </Field>

      <Field label="Pull request" description="Choose a pull request in the selected repository.">
        <Autocomplete
          name="pullRequestId"
          value={values.pullRequestId}
          placeholder={values.fullName ? "Search pull requests..." : "Choose a repository first"}
          disabled={!values.fullName}
          loadOptions={query => ui.listPullRequests(values.fullName ?? "", query)}
          onChange={pullRequestId => setValues({ pullRequestId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<BitbucketConfiguratorRpc, BitbucketPullRequestConfiguratorValues>;
