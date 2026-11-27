import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { isRecord, strictToolRegistration } from './schema.js';

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

it('installs through an accessor inherited from a function prototype', () => {
  const registered: unknown[] = [];

  const callablePrototype = function callablePrototype() {
    return registered;
  };

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

it('installs through an accessor whose readback reads the tool before it delegates', () => {
  const registered: unknown[] = [];
  const names: string[] = [];
  let stored = (tool: unknown): unknown => registered.push(tool);
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => {
      const delegate = stored;

      return (tool: { name: string }) => {
        names.push(tool.name);

        return delegate(tool);
      };
    },
    set: (value: (tool: unknown) => unknown) => {
      stored = value;
    },
  });

  strictToolRegistration(api);
  registerThrough(api, Type.Object({ nested: Type.Object({ value: Type.String() }) }));

  expect(names).toContain('sample');

  expect(registered).toMatchObject([
    {
      parameters: {
        additionalProperties: false,
        properties: { nested: { additionalProperties: false } },
      },
    },
  ]);
});

it("refuses an accessor that returns another API's wrapper while discarding the write", () => {
  const registered: unknown[] = [];
  const installed = registrationApi((tool) => registered.push(tool));

  strictToolRegistration(installed);

  const otherWrapper = installed.registerTool;
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => otherWrapper.bind(api),
    set: () => undefined,
  });

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not writable on this API.');

  expect(registered).toEqual([]);
});

it('registers a tool whose probe marker is not true', () => {
  const registered: unknown[] = [];
  let captured: object = {};
  let stored = (tool: unknown): unknown => registered.push(tool);
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => {
      const delegate = stored;

      return (tool: unknown) => {
        captured = typeof tool === 'object' && tool !== null ? tool : captured;

        return delegate(tool);
      };
    },
    set: (value: (tool: unknown) => unknown) => {
      stored = value;
    },
  });

  strictToolRegistration(api);

  const [marker] = Object.getOwnPropertySymbols(captured);

  if (marker === undefined) {
    throw new Error('the probe carried no marker symbol');
  }

  const register = api.registerTool as unknown as (tool: unknown) => unknown;

  expect(() =>
    register({ name: 'sample', parameters: Type.Object({}), [marker]: false }),
  ).not.toThrow();

  expect(registered).toMatchObject([
    { name: 'sample', parameters: { additionalProperties: false } },
  ]);
});

it('installs through a readback that freezes the tool it receives', () => {
  const registered: unknown[] = [];
  let stored = (tool: unknown): unknown => registered.push(tool);
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => {
      const delegate = stored;

      return (tool: unknown) => {
        Object.freeze(tool);

        return delegate(tool);
      };
    },
    set: (value: (tool: unknown) => unknown) => {
      stored = value;
    },
  });

  expect(() => {
    strictToolRegistration(api);
  }).not.toThrow();

  registerThrough(api, Type.Object({ nested: Type.Object({ value: Type.String() }) }));

  expect(registered).toHaveLength(1);
});

// Pi's registerTool refuses a tool without an object parameter schema before it stores the tool.
const piRegistration =
  (registered: unknown[]) =>
  (tool: unknown): void => {
    const parameters = isRecord(tool) ? tool['parameters'] : undefined;

    const hasObjectParameters =
      typeof parameters === 'object' && parameters !== null && !Array.isArray(parameters);

    if (!hasObjectParameters) {
      throw new Error('must define an object parameter schema');
    }

    registered.push(tool);
  };

it('does not register the probe when the readback reaches the original registration', () => {
  const registered: unknown[] = [];
  const original = piRegistration(registered);
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => (tool: unknown) => {
      original(tool);
    },
    set: () => undefined,
  });

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not writable on this API.');

  expect(registered).toEqual([]);
});

it('handles a rejection from a readback that returns a promise', async () => {
  const rejections: unknown[] = [];

  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };

  process.on('unhandledRejection', onRejection);

  const registered: unknown[] = [];
  let stored = (tool: unknown): unknown => registered.push(tool);
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => async (tool: unknown) => stored(tool),
    set: (value: (tool: unknown) => unknown) => {
      stored = value;
    },
  });

  try {
    expect(() => {
      strictToolRegistration(api);
    }).not.toThrow();

    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    process.off('unhandledRejection', onRejection);
  }

  expect(rejections).toEqual([]);
});

it('refuses a readback that defers the registration until after the check', async () => {
  const rejections: unknown[] = [];

  const onRejection = (reason: unknown): void => {
    rejections.push(reason);
  };

  process.on('unhandledRejection', onRejection);

  const registered: unknown[] = [];
  let stored = (tool: unknown): unknown => registered.push(tool);
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => {
      const delegate = stored;

      return async (tool: unknown) => {
        await Promise.resolve();
        delegate(tool);
      };
    },
    set: (value: (tool: unknown) => unknown) => {
      stored = value;
    },
  });

  try {
    expect(() => {
      strictToolRegistration(api);
    }).toThrow('Cannot install strict tool parameters: registerTool is not writable on this API.');

    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    process.off('unhandledRejection', onRejection);
  }

  expect(registered).toEqual([]);
  expect(rejections).toEqual([]);
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

it('installs through an API that only exposes registerTool through a proxy get trap', () => {
  const registered: unknown[] = [];
  let stored: ((tool: unknown) => unknown) | undefined;

  const proxyTarget: Record<PropertyKey, unknown> = {};

  const api = new Proxy(proxyTarget, {
    get: (value, key) => {
      if (key !== 'registerTool') {
        return value[key];
      }

      return stored ?? ((tool: unknown) => registered.push(tool));
    },
    set: (value, key, assigned: unknown) => {
      if (key !== 'registerTool') {
        value[key] = assigned;

        return true;
      }

      stored = assigned as (tool: unknown) => unknown;

      return true;
    },
  }) as unknown as ExtensionAPI;

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

it('refuses an accessor whose setter discards the write while the getter returns another function', () => {
  const original = passThroughRegisterTool;
  const api = {} as ExtensionAPI;

  Object.defineProperty(api, 'registerTool', {
    configurable: true,
    get: () => original.bind(api),
    set: () => undefined,
  });

  expect(() => {
    strictToolRegistration(api);
  }).toThrow('Cannot install strict tool parameters: registerTool is not writable on this API.');
});

const inheritedExecute = (): string => 'ran';

it('keeps a member the tool inherits from its prototype', () => {
  const registered: unknown[] = [];

  const tool = {
    name: 'sample',
    parameters: Type.Object({ nested: Type.Object({ value: Type.String() }) }),
  };

  Reflect.setPrototypeOf(tool, { execute: inheritedExecute });

  const api = registrationApi((value) => registered.push(value));

  strictToolRegistration(api);

  const register = api.registerTool as unknown as (value: unknown) => unknown;

  register(tool);

  expect(registered).toMatchObject([
    {
      name: 'sample',
      parameters: {
        additionalProperties: false,
        properties: { nested: { additionalProperties: false } },
      },
    },
  ]);

  expect((registered[0] as { execute?: unknown }).execute).toBe(inheritedExecute);
});
