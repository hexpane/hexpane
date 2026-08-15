/* Amplitude analytics, removed for local use.
 * Same module shape as the original bundle so the dynamic import still
 * resolves — every entry point is a no-op. Original kept in .orig-backup/. */
const noop = () => { };
const asyncNoop = () => Promise.resolve();
const chainable = () => new Proxy({}, { get: () => chainable });

class Identify { constructor() { return chainable(); } }
class Revenue { constructor() { return chainable(); } }
const Types = {};

const createInstance = () => chainable();
const add = noop, extendSession = noop, flush = asyncNoop;
const getDeviceId = () => undefined, getSessionId = () => undefined, getUserId = () => undefined;
const groupIdentify = noop, identify = noop, init = noop, logEvent = noop;
const remove = noop, reset = noop, revenue = noop, runQueuedFunctions = noop;
const setDeviceId = noop, setGroup = noop, setOptOut = noop, setSessionId = noop;
const setTransport = noop, setUserId = noop, track = noop;

export {
  Identify, Revenue, Types, add, createInstance, extendSession, flush,
  getDeviceId, getSessionId, getUserId, groupIdentify, identify, init,
  logEvent, remove, reset, revenue, runQueuedFunctions, setDeviceId,
  setGroup, setOptOut, setSessionId, setTransport, setUserId, track
};
