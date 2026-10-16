// MediaRecorder WebM files may omit a duration in their metadata. Decode the
// final seekable frame once, then return to the beginning before playback.
export function seekMedia(video,time){
  return new Promise((resolve,reject)=>{
    if(Math.abs(video.currentTime-time)<.001&&!video.seeking){resolve();return}
    const cleanup=()=>{clearTimeout(timer);video.removeEventListener('seeked',done);video.removeEventListener('error',fail)}
    const done=()=>{cleanup();resolve()},fail=()=>{cleanup();reject(new Error('Не удалось перемотать видео.'))}
    const timer=setTimeout(fail,10000)
    video.addEventListener('seeked',done,{once:true});video.addEventListener('error',fail,{once:true})
    video.currentTime=time
  })
}

export async function readDuration(video){
  if(Number.isFinite(video.duration)&&video.duration>0)return video.duration
  await seekMedia(video,1e10)
  const duration=video.duration
  if(!Number.isFinite(duration)||duration<=0)throw new Error('Не удалось определить длительность видео.')
  await seekMedia(video,0)
  return duration
}
