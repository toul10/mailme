/** Component versions that together form pipelineVersion. */
export const COMPONENT_VERSIONS: Record<string, string> = { cleaner: "c1", resolver: "r2" };

/** Component version values in key order, so pipelineVersion does not depend on object key order. */
export function componentValues(components: Record<string, string>): string[] {
  return Object.keys(components)
    .sort()
    .map((k) => components[k]!);
}
