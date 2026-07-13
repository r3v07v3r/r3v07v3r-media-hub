const path=require('node:path');
const {flipFuses,FuseVersion,FuseV1Options}=require('@electron/fuses');
module.exports=async context=>{
 const executable=path.join(context.appOutDir,'R3V07V3R Media Hub.exe');
 await flipFuses(executable,{version:FuseVersion.V1,[FuseV1Options.RunAsNode]:false,[FuseV1Options.EnableCookieEncryption]:true,[FuseV1Options.EnableNodeOptionsEnvironmentVariable]:false,[FuseV1Options.EnableNodeCliInspectArguments]:false,[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:true,[FuseV1Options.OnlyLoadAppFromAsar]:true,[FuseV1Options.GrantFileProtocolExtraPrivileges]:true});
};
