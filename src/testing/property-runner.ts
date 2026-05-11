import fc from "fast-check";

/**
 * Property-based test runner that wraps fast-check.assert with default numRuns: 100
 * Usage: propertyRunner.assert(property, { numRuns: 100 })
 */
export const propertyRunner = {
  assert: <T>(property: fc.IRawProperty<T>, args?: fc.Parameters<T>): Promise<void> => {
    const result = fc.assert(property, { numRuns: 100, ...args });
    return result instanceof Promise ? result : Promise.resolve(result);
  },
};
