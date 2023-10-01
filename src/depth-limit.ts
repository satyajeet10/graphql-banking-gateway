import { GraphQLError, Kind, type ASTVisitor, type FragmentDefinitionNode, type SelectionSetNode, type ValidationContext } from 'graphql';

/**
 * Validation rule rejecting queries nested deeper than maxDepth.
 * Stops abusive queries like accounts → owner → accounts → owner … before any resolver runs.
 */
export function depthLimit(maxDepth: number) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of context.getDocument().definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
    }

    const depthOf = (set: SelectionSetNode | undefined, depth: number, seen: Set<string>): number => {
      if (!set) return depth;
      let max = depth;
      for (const sel of set.selections) {
        if (sel.kind === Kind.FIELD) {
          if (sel.name.value.startsWith('__')) continue; // introspection
          max = Math.max(max, depthOf(sel.selectionSet, depth + 1, seen));
        } else if (sel.kind === Kind.INLINE_FRAGMENT) {
          max = Math.max(max, depthOf(sel.selectionSet, depth, seen));
        } else {
          const name = sel.name.value;
          if (seen.has(name)) continue;
          max = Math.max(max, depthOf(fragments.get(name)?.selectionSet, depth, new Set(seen).add(name)));
        }
      }
      return max;
    };

    return {
      OperationDefinition(node) {
        const depth = depthOf(node.selectionSet, 0, new Set());
        if (depth > maxDepth) {
          context.reportError(new GraphQLError(`Query depth ${depth} exceeds the limit of ${maxDepth}`, { nodes: [node], extensions: { code: 'QUERY_TOO_DEEP' } }));
        }
      },
    };
  };
}
