import * as WebRTCPlayActions from '../actions/webrtcPlayActions';

const initialState = {
  websocket: undefined,
  peerConnection: undefined,
  audioTrack: undefined,
  videoTrack: undefined,
  // The received MediaStream. Held here rather than in the player so a player that mounts
  // mid-session (back to Play, or over to the combined page) shows the session in progress.
  stream: undefined,
  connected: false
}

const webrtcPlayReducer = (state = initialState, action) => {
  switch (action.type) {
    case WebRTCPlayActions.SET_WEBRTC_PLAY_WEBSOCKET:
      return { ...state, websocket:action.websocket };
    case WebRTCPlayActions.SET_WEBRTC_PLAY_PEERCONNECTION:
      return { ...state, peerConnection:action.peerConnection };
    case WebRTCPlayActions.SET_WEBRTC_PLAY_AUDIO_TRACK:
      return { ...state, audioTrack: action.audioTrack };
    case WebRTCPlayActions.SET_WEBRTC_PLAY_VIDEO_TRACK:
      return { ...state, videoTrack: action.videoTrack };
    case WebRTCPlayActions.SET_WEBRTC_PLAY_STREAM:
      return { ...state, stream: action.stream };
    case WebRTCPlayActions.SET_WEBRTC_PLAY_CONNECTED:
      return { ...state, connected:action.connected };
    default:
      return state
  }
}

export default webrtcPlayReducer;
