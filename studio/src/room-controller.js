import {Room, RoomEvent, Track} from 'livekit-client';
import {approvedEndpoint} from '../../site/src/live-api.js';
import {RemotePlayback} from '../../site/src/remote-playback.js';

const options = (name, kind) => ({name, source: kind === 'video' ? Track.Source.Camera : Track.Source.Microphone,
  simulcast: false, videoCodec: 'vp8', videoEncoding: {maxBitrate: 1500000, maxFramerate: 24},
  audioPreset: {maxBitrate: 48000}, dtx: true, red: true});
const defaultRoom = () => new Room({adaptiveStream: true, dynacast: false,
  publishDefaults: {stopMicTrackOnMute: false, simulcast: false}});

export class StudioRoomController {
  constructor({api, media, roomFactory = defaultRoom, onState = () => {}}) {
    Object.assign(this, {api, media, roomFactory, onState});
    this.room = null; this.tracks = null; this.grant = null; this.mode = 'OFFLINE'; this.epoch = 0;
  }
  bound(extra = {}) { return {sessionId: this.grant?.sessionId, generation: this.grant?.generation, ...extra}; }
  state(value, detail = '') { this.onState(value, detail); }
  async start(previous = null) {
    if (!this.media.isReady()) throw new Error('CAMERA_NOT_READY');
    if (this.room) return;
    const epoch = ++this.epoch;
    this.mode = previous?.state === 'PRIVATE_STANDBY' || previous?.activePrivate ? 'PRIVATE_STANDBY' : 'LIVE';
    this.state('CONNECTING');
    try {
      this.grant = await this.api.call(`/api/admin/live/public/${previous?.sessionId ? 'rejoin' : 'start'}`,
        previous?.sessionId ? {sessionId: previous.sessionId, generation: previous.generation} : {});
      if (epoch !== this.epoch) return;
      await this.connect(epoch);
    } catch (error) { await this.disconnectRoom(); this.state('UNAVAILABLE'); throw error; }
  }
  async connect(epoch) {
    const room = this.roomFactory(); this.room = room;
    room.on(RoomEvent.Reconnecting, () => this.state('RECONNECTING'));
    room.on(RoomEvent.Reconnected, () => this.state(this.mode));
    room.on(RoomEvent.Disconnected, () => {
      if (this.room === room && epoch === this.epoch) this.reconnect();
    });
    await room.connect(approvedEndpoint(this.grant.url), this.grant.token, {autoSubscribe: false});
    if (epoch !== this.epoch) { await this.disconnectRoom(); return; }
    if (this.mode === 'PRIVATE_STANDBY') await this.publishStandby();
    else {
      await this.publishProgram();
      await this.api.call('/api/admin/live/public/published', this.bound());
    }
    this.state(this.mode);
    clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      this.api.call('/api/admin/live/public/heartbeat', this.bound()).catch(error => {
        if ([401,403,409,410].includes(error.status)) this.shutdown();
        else this.state('RECONNECTING');
      });
    }, 10000);
  }
  async reconnect() {
    if (this.reconnecting || this.mode === 'OFFLINE') return;
    this.reconnecting = true; this.state('RECONNECTING');
    const epoch = this.epoch;
    try {
      await this.disconnectRoom();
      for (let attempt=0; attempt<3; attempt++) {
        try {
          if (epoch !== this.epoch) return;
          this.grant = await this.api.call('/api/admin/live/public/rejoin', this.bound());
          if (epoch !== this.epoch) return;
          await this.connect(epoch); return;
        } catch (error) {
          await this.disconnectRoom();
          if ([401,403,409,410].includes(error.status) || attempt===2) throw error;
          await new Promise(resolve=>setTimeout(resolve, 1000*(attempt+1)));
        }
      }
    } catch { this.state('UNAVAILABLE', 'Reconectarea nu a reușit. Oprește emisia și pornește din nou.'); }
    finally { this.reconnecting = false; }
  }
  async publishProgram(muted = false) {
    const tracks = this.media.createRoomTracks(); this.tracks = tracks;
    if (muted) await tracks.audioTrack.mute();
    const videoOptions=options('public-program','video');
    videoOptions.videoEncoding.maxBitrate=this.media.profile?.bitrate || 1500000;
    await this.room.localParticipant.publishTrack(tracks.videoTrack, videoOptions);
    await this.room.localParticipant.publishTrack(tracks.audioTrack, options('public-audio','audio'));
  }
  async removeProgram() {
    const tracks = this.tracks; this.tracks = null;
    if (!tracks) return;
    try {
      await this.room.localParticipant.unpublishTrack(tracks.audioTrack, true);
      await this.room.localParticipant.unpublishTrack(tracks.videoTrack, true);
    } finally { tracks.audioTrack.stop(); tracks.videoTrack.stop(); }
  }
  async publishStandby() {
    if (this.standby) return;
    this.standby = this.media.createStandbyVideoTrack();
    await this.room.localParticipant.publishTrack(this.standby, options('public-standby','video'));
  }
  async standbyOnly() {
    this.mode = 'PRIVATE_STANDBY';
    try { await this.removeProgram(); await this.publishStandby(); this.state(this.mode); }
    catch (error) { await this.disconnectRoom(); this.state('UNAVAILABLE'); throw error; }
  }
  async resume(id) {
    if (!this.room || this.mode !== 'PRIVATE_STANDBY') throw new Error('STANDBY_REQUIRED');
    try {
      await this.publishProgram(true);
      const permit = await this.api.call('/api/admin/live/private/prepare-resume', this.bound({id}));
      await this.room.localParticipant.unpublishTrack(this.standby, true);
      this.standby.stop(); this.standby = null;
      await this.tracks.audioTrack.unmute();
      await this.api.call('/api/admin/live/private/resumed', this.bound({id, authorization: permit.authorization, revision: permit.revision}));
      this.mode='LIVE'; this.state('LIVE');
    } catch (error) { await this.standbyOnly(); throw error; }
  }
  async disconnectRoom() {
    clearInterval(this.heartbeat);
    const room=this.room; this.room=null;
    for (const track of [this.tracks?.videoTrack,this.tracks?.audioTrack,this.standby]) track?.stop();
    this.tracks=null; this.standby=null;
    if (room) await room.disconnect(false);
  }
  async offAir() {
    ++this.epoch; this.mode='OFFLINE';
    await this.disconnectRoom();
    if (this.grant) {
      await this.api.call('/api/admin/live/public/stop',this.bound(),{keepalive:true});
      this.grant=null;
    }
    this.state('OFFLINE');
  }
  async shutdown() {
    try { await this.offAir(); } finally { this.media.stop(); }
  }
}

export class PrivateCallController {
  constructor({controller, api, media, roomFactory=defaultRoom, onState=()=>{}, video, soundButton}) {
    Object.assign(this,{controller,api,media,roomFactory,onState,video,soundButton});
    this.id=null; this.room=null; this.epoch=0;
  }
  async accept(id) {
    if (this.id) throw new Error('PRIVATE_ACTIVE');
    const epoch=++this.epoch;
    await this.api.call('/api/admin/live/private/accept',this.controller.bound({id}));
    if(epoch!==this.epoch) return;
    this.id=id;
    await this.controller.standbyOnly();
    if(epoch!==this.epoch) return;
    await this.api.call('/api/admin/live/private/standby-ready',this.controller.bound({id}));
    if(epoch!==this.epoch) return;
    const grant=await this.api.call('/api/admin/live/private/dj-token',this.controller.bound({id}));
    if(epoch!==this.epoch) return;
    try {
      await this.join(grant,epoch);
      this.onState('PRIVATE_STANDBY','Apel privat pregătit. Publicul vede doar pauza.');
    } catch(error) { await this.dispose(); throw error; }
  }
  async join(grant,epoch) {
    const room=this.roomFactory(); this.room=room;
    if(this.video) {
      this.playback=new RemotePlayback({room,video:this.video,soundButton:this.soundButton,role:'private-guest',
        videoNames:['private-guest-video'],audioName:'private-guest-audio',onBlocked:text=>this.onState('PRIVATE_STANDBY',text)});
      room.on(RoomEvent.TrackSubscribed,(...args)=>this.playback?.accept(...args));
      room.on(RoomEvent.TrackUnsubscribed,track=>this.playback?.remove(track));
      room.on(RoomEvent.AudioPlaybackStatusChanged,()=>this.playback?.playbackChanged());
    }
    room.on(RoomEvent.Disconnected,()=>{ if(this.room===room && epoch===this.epoch) this.reconnect(); });
    await room.connect(approvedEndpoint(grant.url),grant.token,{autoSubscribe:true});
    if(epoch!==this.epoch) { await this.dispose(); return; }
    this.tracks=this.media.createRoomTracks();
    await room.localParticipant.publishTrack(this.tracks.videoTrack,options('private-dj-video','video'));
    await room.localParticipant.publishTrack(this.tracks.audioTrack,options('private-dj-audio','audio'));
  }
  async reconnect() {
    if(this.reconnecting || !this.id) return;
    this.reconnecting=true;
    const epoch=this.epoch, id=this.id;
    try {
      await this.dispose();
      if(epoch!==this.epoch || id!==this.id) return;
      const grant=await this.api.call('/api/admin/live/private/dj-token',this.controller.bound({id}));
      if(epoch!==this.epoch || id!==this.id) return;
      await this.join(grant,epoch);
    } catch { this.onState('PRIVATE_STANDBY','Apel întrerupt. Publicul rămâne fără sunet. Încheie apelul pentru revenire.'); }
    finally { this.reconnecting=false; }
  }
  async dispose() {
    const room=this.room; this.room=null;
    this.playback?.close(); this.playback=null;
    this.tracks?.videoTrack.stop(); this.tracks?.audioTrack.stop(); this.tracks=null;
    if(room) await room.disconnect(false);
  }
  async abort() { ++this.epoch; await this.dispose(); }
  async end(resume=true) {
    ++this.epoch;
    const id=this.id;
    await this.dispose();
    if(!id) return;
    await this.api.call('/api/admin/live/private/end',this.controller.bound({id}));
    if(resume) await this.controller.resume(id);
    this.id=null;
  }
}
