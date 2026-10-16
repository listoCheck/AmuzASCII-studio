export function clipboardImage(data){
  if(!data)return null
  for(const item of Array.from(data.items||[])){
    if(item.kind==='file'&&item.type?.startsWith('image/')){
      const file=item.getAsFile()
      if(file)return file
    }
  }
  return Array.from(data.files||[]).find(file=>file.type?.startsWith('image/'))||null
}
