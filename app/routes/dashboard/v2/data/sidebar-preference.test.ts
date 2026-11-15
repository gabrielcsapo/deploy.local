import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  designPanelHidden,
  rememberDesignPanel,
  sidebarCollapsed,
  rememberSidebar,
  sidebarPreferenceKey,
} from './sidebar-preference';

test('one device preference, expanded by default, ignores old page-kind choices', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map([
    ['deploy.sidebar.design', 'true'],
    ['deploy.sidebar.pages', 'true'],
  ]);
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key),
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    assert.equal(sidebarCollapsed(), false);
    rememberSidebar(true);
    for (const _page of ['Projects', 'Changes', 'Code', 'Design'])
      assert.equal(sidebarCollapsed(), true);
    rememberSidebar(false);
    assert.equal(sidebarCollapsed(), false);
    values.set(sidebarPreferenceKey, 'invalid');
    assert.equal(sidebarCollapsed(), false);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    assert.equal(sidebarCollapsed(), false);
    assert.doesNotThrow(() => rememberSidebar(true));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('each canvas panel is remembered on its own, open by default', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    assert.equal(designPanelHidden('left'), false);
    assert.equal(designPanelHidden('right'), false);
    rememberDesignPanel('left', true);
    assert.equal(designPanelHidden('left'), true);
    assert.equal(designPanelHidden('right'), false);
    rememberSidebar(true);
    rememberDesignPanel('right', true);
    rememberDesignPanel('left', false);
    assert.equal(designPanelHidden('left'), false);
    assert.equal(designPanelHidden('right'), true);
    assert.equal(sidebarCollapsed(), true);
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    assert.equal(designPanelHidden('right'), false);
    assert.doesNotThrow(() => rememberDesignPanel('right', false));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
