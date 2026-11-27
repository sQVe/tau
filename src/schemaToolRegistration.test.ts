import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { strictToolRegistration } from './schema.js';

const registrationApi = (registerTool: (tool: unknown) => unknown): ExtensionAPI =>
  ({ registerTool }) as unknown as ExtensionAPI;

const registerThrough = (api: ExtensionAPI, parameters: TSchema): unknown => {
  const register = api.registerTool as unknown as (tool: unknown) => unknown;

  return register({ name: 'sample', parameters });
};

it('closes the parameters of a tool registered through the wrapped API', () => {
  const registered: unknown[] = [];
  const api = registrationApi((tool) => registered.push(tool));

  strictToolRegistration(api);
  registerThrough(api, Type.Object({ nested: Type.Object({ value: Type.String() }) }));

  expect(registered).toMatchObject([
    {
      name: 'sample',
      parameters: {
        additionalProperties: false,
        properties: { nested: { additionalProperties: false } },
      },
    },
  ]);
});

it('installs the wrapper once per API', () => {
  const registered: unknown[] = [];
  const api = registrationApi((tool) => registered.push(tool));

  strictToolRegistration(api);
  const wrapper = api.registerTool;

  strictToolRegistration(api);

  registerThrough(api, Type.Object({}));

  expect(api.registerTool).toBe(wrapper);
  expect(registered).toHaveLength(1);
});

it('installs through an API that intercepts reads of registerTool', () => {
  const registered: unknown[] = [];
  const target = registrationApi((tool) => registered.push(tool));

  const api = new Proxy(target, {
    get: (value, key) => {
      const properties = value as unknown as Record<PropertyKey, unknown>;
      const property = properties[key];

      if (key !== 'registerTool' || typeof property !== 'function') {
        return property;
      }

      const registerTool = property as (tool: unknown) => unknown;

      return (tool: unknown) => registerTool(tool);
    },
  });

  strictToolRegistration(api);
  registerThrough(api, Type.Object({ nested: Type.Object({ value: Type.String() }) }));

  expect(registered).toMatchObject([
    {
      name: 'sample',
      parameters: {
        additionalProperties: false,
        properties: { nested: { additionalProperties: false } },
      },
    },
  ]);
});

it('installs through an API that stores registerTool in an accessor', () => {
  const registered: unknown[] = [];
  let stored = (tool: unknown): unknown => registered.push(tool);
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => stored,
    set: (value: (tool: unknown) => unknown) => {
      stored = value;
    },
  });

  strictToolRegistration(api);
  registerThrough(api, Type.Object({ nested: Type.Object({ value: Type.String() }) }));

  expect(registered).toMatchObject([
    {
      name: 'sample',
      parameters: {
        additionalProperties: false,
        properties: { nested: { additionalProperties: false } },
      },
    },
  ]);
});

const callablePrototype = function callablePrototype() {};

it('installs through an accessor inherited from a function prototype', () => {
  const registered: unknown[] = [];
  let stored = (tool: unknown): unknown => registered.push(tool);

  Object.defineProperty(callablePrototype, 'registerTool', {
    configurable: true,
    get: () => stored,
    set: (value: (tool: unknown) => unknown) => {
      stored = value;
    },
  });

  const api = Object.setPrototypeOf(
    function host() {},
    callablePrototype,
  ) as unknown as ExtensionAPI;

  strictToolRegistration(api);
  registerThrough(api, Type.Object({ nested: Type.Object({ value: Type.String() }) }));

  expect(registered).toMatchObject([
    {
      parameters: {
        additionalProperties: false,
        properties: { nested: { additionalProperties: false } },
      },
    },
  ]);
});

it('installs through an accessor on the prototype', () => {
  const registered: unknown[] = [];

  class Api {
    #register: (tool: unknown) => unknown = (tool) => registered.push(tool);

    get registerTool(): (tool: unknown) => unknown {
      return this.#register;
    }

    set registerTool(value: (tool: unknown) => unknown) {
      this.#register = value;
    }
  }

  const api = new Api() as unknown as ExtensionAPI;

  strictToolRegistration(api);
  registerThrough(api, Type.Object({ nested: Type.Object({ value: Type.String() }) }));

  expect(registered).toMatchObject([
    {
      parameters: {
        additionalProperties: false,
        properties: { nested: { additionalProperties: false } },
      },
    },
  ]);
});

it('installs through an accessor that returns a new bound wrapper on every read', () => {
  const registered: unknown[] = [];
  let stored = (tool: unknown): unknown => registered.push(tool);
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => stored.bind(api),
    set: (value: (tool: unknown) => unknown) => {
      stored = value;
    },
  });

  strictToolRegistration(api);
  registerThrough(api, Type.Object({ nested: Type.Object({ value: Type.String() }) }));

  expect(registered).toMatchObject([
    {
      parameters: {
        additionalProperties: false,
        properties: { nested: { additionalProperties: false } },
      },
    },
  ]);
});

const passThroughRegisterTool = (tool: unknown): unknown => tool;

it('restores the original registerTool when the readback fails', () => {
  const original = passThroughRegisterTool;
  const api = { registerTool: original } as unknown as ExtensionAPI;
  let stored: (tool: unknown) => unknown = original;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => {
      if (stored !== original) {
        throw new Error('the getter failed');
      }

      return stored;
    },
    set: (value: (tool: unknown) => unknown) => {
      stored = value;
    },
  });

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not readable on this API.');

  expect(stored).toBe(original);
});

it('keeps the value the wrapped registration returns', () => {
  const api = registrationApi(() => 'registered');

  strictToolRegistration(api);

  expect(registerThrough(api, Type.Object({}))).toBe('registered');
});

it('reports an accessor whose setter discards the assignment as not writable', () => {
  const original = passThroughRegisterTool;
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => original,
    set: () => undefined,
  });

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not writable on this API.');
});

it('reports a clear error when registerTool is not a function', () => {
  const api = {} as unknown as ExtensionAPI;

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not a function.');
});

it('reports a clear error when registerTool cannot be replaced', () => {
  const api = registrationApi(() => undefined);

  Object.defineProperty(api, 'registerTool', { configurable: false, writable: false });

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not writable on this API.');
});

it('reports a clear error when registerTool ignores the replacement', () => {
  const api = new Proxy(
    registrationApi(() => undefined),
    { set: () => true },
  );

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not writable on this API.');
});

it('reports a read failure with its own message and cause', () => {
  const failure = new TypeError('the getter failed');
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => {
      throw failure;
    },
    set: () => undefined,
  });

  let thrown: unknown;

  try {
    strictToolRegistration(api);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({
    message: 'Cannot install strict tool parameters: registerTool is not readable on this API.',
    cause: failure,
  });
});

it('binds the registerTool it read once', () => {
  const api = {} as ExtensionAPI;
  const registered: unknown[] = [];
  const register = (tool: unknown): unknown => registered.push(tool);
  let stored: unknown;
  let reads = 0;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => {
      reads += 1;

      return stored ?? (reads === 1 ? register : undefined);
    },
    set: (value: unknown) => {
      stored = value;
    },
  });

  expect(() => {
    strictToolRegistration(api);
  }).not.toThrow();

  registerThrough(api, Type.Object({}));

  expect(registered).toHaveLength(1);
});

it('reports a read failure when reading registerTool back throws', () => {
  const api = {} as ExtensionAPI;
  let assigned: unknown;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => {
      if (assigned !== undefined) {
        throw new Error('the getter failed');
      }

      return () => undefined;
    },
    set: (value: unknown) => {
      assigned = value;
    },
  });

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not readable on this API.');
});
