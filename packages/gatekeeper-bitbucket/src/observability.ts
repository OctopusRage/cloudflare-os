import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Bitbucket gatekeeper. */
export type BitbucketObservabilityFields = {
  vendorId: string;
};

/** Ambient observability fields for one Bitbucket gatekeeper operation. */
export const obsContext = createObservabilityContext<BitbucketObservabilityFields>();
