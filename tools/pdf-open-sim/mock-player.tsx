import { useEffect } from 'react';

export function YouTubePlayer(props: any) {
  (globalThis as any).__pdfOpenSim.player = props;
  useEffect(() => { props.onReady(); }, [props.source.token]);
  return <div data-test-player />;
}
export const FilePlayer = YouTubePlayer;
