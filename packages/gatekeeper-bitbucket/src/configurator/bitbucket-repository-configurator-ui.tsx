import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { BitbucketConfiguratorRpc, BitbucketRepositoryConfiguratorValues } from "./bitbucket-configurator-types";

const ORIGIN = "https://bitbucket.org";

/** `workspace/repo` from any bitbucket.org link into a repository, or null. */
function fullNameFromUrl(resourceUrl: string): string | null {
  try {
    const url = new URL(resourceUrl);
    if (url.origin !== ORIGIN) return null;
    const [workspace, repo] = url.pathname.split("/").filter(Boolean);
    return workspace && repo ? `${workspace}/${repo.replace(/\.git$/, "")}` : null;
  } catch {
    return null;
  }
}

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.fullName === "string" && values.fullName.includes("/");
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const fullName = fullNameFromUrl(resourceUrl);
    return fullName ? { fullName } : {};
  },

  async resourceUrl({ values }) {
    return `${ORIGIN}/${values.fullName}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Repository" description="Search your repositories, or paste a Bitbucket repository URL or workspace/repo.">
        <Autocomplete
          name="fullName"
          value={values.fullName}
          placeholder="Search or paste a repository URL..."
          loadOptions={query => ui.listRepositories(query)}
          onChange={fullName => setValues({ fullName })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<BitbucketConfiguratorRpc, BitbucketRepositoryConfiguratorValues>;
