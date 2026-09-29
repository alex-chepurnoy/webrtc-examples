import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import * as PublishSettingsActions from '../../actions/publishSettingsActions';
import * as WebRTCPublishActions from '../../actions/webrtcPublishActions';
import * as ErrorsActions from '../../actions/errorsActions';
import * as DataChannelActions from '../../actions/dataChannelActions';
import { describeReceivedMessage } from '../../utils/DataChannelUtils';
import { DATA_CHANNELS_UNAVAILABLE_MESSAGE } from '../../webrtc/attachDataChannel';

import startPublish from '../../webrtc/startPublish';
import stopPublish from '../../webrtc/stopPublish';
import replaceAudioTrack from '../../webrtc/replaceAudioTrack';
import replaceVideoTrack from '../../webrtc/replaceVideoTrack';
import {
  applyAudioSenderParameters,
  applyVideoSenderParameters,
  audioSenderSettings,
  videoSenderSettings,
} from '../../utils/SenderParameters';

const Publisher = () => {

  const dispatch = useDispatch();
  const publishSettings = useSelector ((state) => state.publishSettings);
  const webrtcPublish = useSelector ((state) => state.webrtcPublish);

  // Listen for changes in the publish* flags in the publishSettings store
  // and stop or stop publishing accordingly

  useEffect(() => {

    if (publishSettings.publishStart && !publishSettings.publishStarting && !webrtcPublish.connected)
    {
      dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStart:false, publishStarting:true});
      startPublish(publishSettings,webrtcPublish.websocket,{
        onError: (error) => {
          dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:error.message});
          dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStarting:false, publishStart:false});
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_WEBSOCKET, websocket:null});
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION, peerConnection:null});
          dispatch(DataChannelActions.resetDataChannel('publish'));
        },
        // A warning is shown but changes nothing else: the session stays up. Used when the
        // server refuses the video track while audio keeps flowing.
        onWarning: (warning) => {
          dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:warning.message});
        },
        onConnectionStateChange: (result) => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_CONNECTED,connected:result.connected});
        },
        onSetPeerConnection: (result) => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION,peerConnection:result.peerConnection});
        },
        onSetWebsocket: (result) => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_WEBSOCKET,websocket:result.websocket});
        },
        onSetSenders: (senders) => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION_AUDIO_SENDER,peerConnectionAudioSender:senders.audioSender});
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION_VIDEO_SENDER,peerConnectionVideoSender:senders.videoSender});
        },
        onSetDataChannel: (result) => {
          dispatch(DataChannelActions.setDataChannelHandle('publish', result.dataChannel));
        },
        onDataChannelStateChange: (result) => {
          dispatch(DataChannelActions.setDataChannelState('publish', result));
        },
        onDataChannelMessage: (result) => {
          dispatch(DataChannelActions.addDataChannelMessage('publish', describeReceivedMessage(result)));
        },
        onDataChannelError: (result) => {
          dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:'Data channel error: ' + result.message});
        },
        onDataChannelsUnavailable: () => {
          // Publishing is unaffected, so this only reports - no media state is touched.
          dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:DATA_CHANNELS_UNAVAILABLE_MESSAGE});
        },
        onCaption: (result) => {
          dispatch(DataChannelActions.setCaption('publish', result.text));
        }
      });
    }
    if (publishSettings.publishStarting && webrtcPublish.connected)
    {
      dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStarting:false});
    }

    if (publishSettings.publishStop && !publishSettings.publishStopping && webrtcPublish.connected)
    {
      dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStop:false, publishStopping:true});
      stopPublish(publishSettings.useWhip, webrtcPublish.peerConnection,webrtcPublish.websocket,{
        onSetPeerConnection: (result) => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION,peerConnection:result.peerConnection});
        },
        onSetWebsocket: (result) => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_WEBSOCKET,websocket:result.websocket});
        },
        onPublishStopped: () => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_CONNECTED,connected:false});
          dispatch(DataChannelActions.resetDataChannel('publish'));
        }
      });
    }
    if (publishSettings.publishStopping && !webrtcPublish.connected)
    {
      dispatch({type:PublishSettingsActions.SET_PUBLISH_FLAGS, publishStopping:false});
    }


  }, [dispatch,publishSettings,webrtcPublish]);

  // Handle Mic and Cam Track Changes
  const { audioTrack, videoTrack } = useSelector ((state) => state.publishSettings);
  const {
    peerConnection,
    peerConnectionAudioSender: audioSender,
    peerConnectionVideoSender: videoSender,
  } = useSelector((state) => state.webrtcPublish);

  useEffect(() => {
    if (peerConnection != null) {
      replaceAudioTrack(audioTrack, audioSender, peerConnection, {
        onSetSenders: (senders) => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION_AUDIO_SENDER,peerConnectionAudioSender:senders.audioSender});
        }
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[dispatch,audioTrack]);

  useEffect(() => {
    if (peerConnection != null) {
      replaceVideoTrack(videoTrack, videoSender, peerConnection, {
        onSetSenders: (senders) => {
          dispatch({type:WebRTCPublishActions.SET_WEBRTC_PUBLISH_PEERCONNECTION_VIDEO_SENDER,peerConnectionVideoSender:senders.videoSender});
        }
      });
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[dispatch,videoTrack]);

  // The sender limits: bitrate caps, simulcast scale down and bitrate per rendition, and
  // what to give up when bandwidth is short. All of them can change mid-stream.
  //
  // startPublish applies them once as soon as the senders exist, so a stream starts capped;
  // these effects cover every change after that. Both go through the per-sender queue in
  // SenderParameters.js, so two setParameters never overlap on one sender. They depend on
  // the sender objects themselves: replaceVideoTrack and replaceAudioTrack add a new sender
  // when there was none, and that one needs the limits too. Re-runs on connect, so values
  // edited while connecting are picked up. An invalid cap is passed as undefined, which
  // leaves the running value alone while the field shows its error.
  const {
    useSimulcast,
    simulcastRenditions,
    videoMaxBitrateKbps,
    audioMaxBitrateKbps,
    degradationPreference,
  } = publishSettings;
  const connected = webrtcPublish.connected;

  useEffect(() => {
    if (!connected || videoSender == null) return;

    applyVideoSenderParameters(videoSender, videoSenderSettings({
      useSimulcast, simulcastRenditions, videoMaxBitrateKbps, degradationPreference,
    })).catch((error) => {
      dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:'Could not apply the video limits: ' + error.message});
    });
  },[dispatch,connected,videoSender,useSimulcast,simulcastRenditions,videoMaxBitrateKbps,degradationPreference]);

  useEffect(() => {
    if (!connected || audioSender == null) return;

    applyAudioSenderParameters(audioSender, audioSenderSettings({ audioMaxBitrateKbps })).catch((error) => {
      dispatch({type:ErrorsActions.SET_ERROR_MESSAGE, message:'Could not apply the audio limit: ' + error.message});
    });
  },[dispatch,connected,audioSender,audioMaxBitrateKbps]);

  return <></>;
}

export default Publisher;
