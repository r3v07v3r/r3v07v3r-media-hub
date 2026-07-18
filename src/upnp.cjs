async function attemptPortMapping(localPort,localHost,{timeoutMs=8000}={}){
 try{
  const {upnpNat}=await import('@achingbrain/nat-port-mapper');
  const client=upnpNat();
  for await(const gateway of client.findGateways({signal:AbortSignal.timeout(timeoutMs)})){
   try{
    const mapping=await gateway.map(localPort,localHost,{protocol:'tcp'});
    const externalIp=await gateway.externalIp();
    if(!externalIp)continue;
    return{ip:externalIp,port:Number(mapping?.externalPort)||localPort,stop:()=>gateway.stop().catch(()=>{})};
   }catch{continue}
  }
  return null;
 }catch{
  return null;
 }
}
module.exports={attemptPortMapping};
