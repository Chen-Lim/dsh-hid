export const PLUGIN_NAME = 'dsh-plugin-peripheral-server';

export * from './router.js';
export * from './ws-server.js';
export * from './arbiter.js';
export * from './service.js';

export { apply as default } from './service.js';
