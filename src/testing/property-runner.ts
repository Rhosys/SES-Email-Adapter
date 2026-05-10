import fc from "fast-check";

/**
 * Property-based test runner that wraps fast-check.assert with default numRuns: 100
 * Usage: propertyRunner.assert(property, { numRuns: 100 })
 */
export const propertyRunner = {
  assert: <T>(property: fc.AsyncProperty<T>, args?: fc.PropertiesArguments) => {
    return fc.assert(property, { numRuns: 100, ...args });
  },
};
