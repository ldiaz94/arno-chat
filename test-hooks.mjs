/** Node loader hook for the tests: `cloudflare:workers` exists only inside the
 * Workers runtime, so the tests get minimal stand-ins for its two base classes.
 * Run as `node --import ./test-hooks.mjs --test test.mjs` (npm test). */
import {register} from 'node:module';
const stub='export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}export class WorkerEntrypoint{}';
const hooks=`export async function resolve(specifier,context,next){
 if(specifier==='cloudflare:workers')return {url:'data:text/javascript,'+encodeURIComponent(${JSON.stringify(stub)}),shortCircuit:true};
 return next(specifier,context);
}`;
register('data:text/javascript,'+encodeURIComponent(hooks));
