/**
 * Global test setup for vitest.
 * Installs Chrome extension API mocks before each test.
 */

import { beforeEach, afterEach } from 'vitest';
import { installMockChrome, uninstallMockChrome } from './chrome-mock';

beforeEach(() => {
  installMockChrome();
});

afterEach(() => {
  uninstallMockChrome();
});
