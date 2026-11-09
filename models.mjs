export const DEFAULT_MODEL = 'mistral-large-4:cloud';
export const FALLBACK_MODELS = [
  {id:DEFAULT_MODEL,name:'Mistral Large 4 · Le Chonk'},
  {id:'devstral-2:123b-cloud',name:'Devstral 2 · 123B'},
  {id:'qwen3-coder:480b-cloud',name:'Qwen3 Coder · 480B'}
];
export async function catalog(upstream=fetch) {
  try {
    const response=await upstream('https://ollama.com/api/tags',{signal:AbortSignal.timeout(8000),cf:{cacheTtl:300,cacheEverything:true}});
    if(!response.ok)throw Error('Catalog unavailable');
    const data=await response.json();
    const models=data.models.filter(m=>m.capabilities?.includes('completion')&&m.capabilities?.includes('tools')&&/^[a-z0-9][a-z0-9:._-]{0,120}$/.test(m.name)).map(m=>({id:m.name,name:m.name}));
    if(!models.length)throw Error('Empty catalog');
    const unique=new Map([[DEFAULT_MODEL,FALLBACK_MODELS[0]],...models.map(m=>[m.id,m])]);
    return {models:[...unique.values()],source:'ollama',fallback:false};
  }catch{
    return {models:FALLBACK_MODELS,source:'fallback',fallback:true};
  }
}
export async function modelAllowed(model) {
  if(/^(openai|anthropic)\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,120}$/.test(model))return true;
  return (await catalog()).models.some(m=>m.id===model)||FALLBACK_MODELS.some(m=>m.id===model);
}
