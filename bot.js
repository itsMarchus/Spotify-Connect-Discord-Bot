const { Client, GatewayIntentBits } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  StreamType,
  entersState
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const path = require('path');
const fs = require('fs');

// Support both standalone executable (pkg) and standard node execution
const isPkg = typeof process.pkg !== 'undefined';
const appDir = isPkg ? path.dirname(process.execPath) : process.cwd();

// Load .env from the application directory
require('dotenv').config({ path: path.join(appDir, '.env') });

const isWindows = process.platform === 'win32';

// Check if user requested listing available audio devices
if (process.argv.includes('--list-devices')) {
  listAudioDevices();
  return;
}

console.log('====================================================');
console.log('       Spotify Connect Discord Voice Bot            ');
console.log('====================================================');

// Validate critical environment variables
const requiredEnv = ['DISCORD_TOKEN', 'GUILD_ID', 'VOICE_CHANNEL_ID'];
const missingEnv = requiredEnv.filter(key => !process.env[key]);

if (missingEnv.length > 0) {
  console.error(`\n[Configuration Error] Missing required environment variable(s) in .env:`);
  missingEnv.forEach(key => console.error(`  - ${key}`));
  console.error(`\nPlease configure them in: ${path.join(appDir, '.env')}\n`);
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

let audioPlayer = null;
let voiceConnection = null;
let activeAudioProcess = null;
let isShuttingDown = false;

client.once('clientReady', async () => {
  console.log(`[Bot] Authenticated as ${client.user.tag}`);

  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (!guild) {
    console.error(`[Error] Target Guild ID (${process.env.GUILD_ID}) not found. Verify your bot is invited to the server.`);
    process.exit(1);
  }

  const voiceChannel = guild.channels.cache.get(process.env.VOICE_CHANNEL_ID);
  if (!voiceChannel) {
    console.error(`[Error] Target Voice Channel ID (${process.env.VOICE_CHANNEL_ID}) not found in server "${guild.name}".`);
    process.exit(1);
  }

  console.log(`[Voice] Connecting to channel: "${voiceChannel.name}" in "${guild.name}"...`);

  // Establish voice connection
  voiceConnection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true
  });

  audioPlayer = createAudioPlayer();
  voiceConnection.subscribe(audioPlayer);

  voiceConnection.on(VoiceConnectionStatus.Ready, () => {
    console.log('[Voice] Voice connection ready. Initializing audio pipeline...');
    startAudioPipeline();
  });

  voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      // Attempt reconnection if disconnected temporarily
      await Promise.race([
        entersState(voiceConnection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      console.log('[Voice] Disconnected from channel. Cleaning up...');
      cleanup();
    }
  });

  voiceConnection.on(VoiceConnectionStatus.Destroyed, () => {
    cleanup();
  });
});

function startAudioPipeline() {
  const mode = (process.env.AUDIO_MODE || 'cable').toLowerCase();
  if (mode === 'librespot') {
    startLibrespotPipe();
  } else {
    startCablePipe();
  }
}

/**
 * Plan B: Captures audio from a virtual audio cable (e.g. VB-CABLE) using ffmpeg.
 * Official Spotify Desktop streams to VB-CABLE, eliminating DRM / AudioKeyError issues.
 */
function startCablePipe() {
  cleanupAudioProcess();

  const binaryName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
  let binaryPath = path.resolve(appDir, binaryName);

  if (!fs.existsSync(binaryPath)) {
    binaryPath = binaryName; // Fallback to system PATH
  }

  const deviceName = process.env.AUDIO_DEVICE_NAME || 'CABLE Output (VB-Audio Virtual Cable)';
  console.log(`[Audio Mode] VB-CABLE Loopback (Spotify Desktop App)`);
  console.log(`[Audio] Capturing from: "${deviceName}"...`);

  let args = [];
  if (isWindows) {
    args = [
      '-f', 'dshow',
      '-i', `audio=${deviceName}`,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-loglevel', 'warning',
      'pipe:1'
    ];
  } else if (process.platform === 'darwin') {
    args = [
      '-f', 'avfoundation',
      '-i', ':0',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-loglevel', 'warning',
      'pipe:1'
    ];
  } else {
    args = [
      '-f', 'pulse',
      '-i', 'default',
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-loglevel', 'warning',
      'pipe:1'
    ];
  }

  try {
    activeAudioProcess = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.error(`\n[Audio Error] Failed to launch ffmpeg: ${err.message}`);
    console.error(`Ensure "${binaryName}" is in the bot directory or installed on system PATH.\n`);
    return;
  }

  const audioStream = new PassThrough();

  activeAudioProcess.stdout.on('data', (chunk) => {
    audioStream.write(chunk);
  });

  activeAudioProcess.stdout.on('end', () => audioStream.end());
  activeAudioProcess.stdout.on('error', (err) => audioStream.destroy(err));

  let stderrOutput = '';
  activeAudioProcess.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });

  activeAudioProcess.on('error', (err) => {
    console.error('[Audio Capture Error]', err.message);
  });

  activeAudioProcess.on('close', (code) => {
    if (code !== 0 && code !== null && !isShuttingDown) {
      console.error(`[Audio Capture] ffmpeg exited with code ${code}.`);
      if (stderrOutput.includes('Could not find') || stderrOutput.includes('audio only device')) {
        console.error(`\n[Audio Device Error] Could not find audio recording device "${deviceName}".`);
        console.error('Make sure VB-CABLE is installed and that AUDIO_DEVICE_NAME in .env matches your device.');
        console.error('Run: node bot.js --list-devices to view detected recording devices on your PC.\n');
      } else if (stderrOutput.trim()) {
        console.error(`[ffmpeg details]: ${stderrOutput.trim()}`);
      }
    }
  });

  const resource = createAudioResource(audioStream, {
    inputType: StreamType.Raw,
    inlineVolume: true
  });

  audioPlayer.play(resource);

  audioPlayer.on(AudioPlayerStatus.Playing, () => {
    console.log('[Playback] Audio streaming to Discord voice channel.');
  });

  audioPlayer.on(AudioPlayerStatus.Idle, () => {
    console.log('[Playback] Audio stream paused/idle.');
  });

  audioPlayer.on('error', (err) => {
    console.error('[Playback Error]', err.message);
  });
}

/**
 * Plan A: Direct Spotify Connect endpoint using librespot.
 * Suitable for older accounts not blocked by server-side key restrictions.
 */
function startLibrespotPipe() {
  cleanupAudioProcess();

  const binaryName = isWindows ? 'librespot.exe' : 'librespot';
  const binaryPath = path.resolve(appDir, binaryName);

  if (!fs.existsSync(binaryPath)) {
    console.error(`\n[Spotify Error] "${binaryName}" was not found!`);
    console.error(`Expected location: ${binaryPath}`);
    console.error(`Download librespot from: https://github.com/librespot-org/librespot/releases`);
    console.error(`Place "${binaryName}" in the same folder as this bot, then restart.\n`);
    return;
  }

  const deviceName = process.env.SPOTIFY_DEVICE_NAME || 'Discord Bot Speaker';
  const deviceType = process.env.SPOTIFY_DEVICE_TYPE || 'computer';
  const bitrate = process.env.SPOTIFY_BITRATE || '160';
  const cacheDir = path.join(appDir, '.cache');

  const args = [
    '--name', deviceName,
    '--device-type', deviceType,
    '--backend', 'pipe',
    '--initial-volume', '100',
    '--bitrate', bitrate,
    '--cache', cacheDir
  ];

  const credentialsFile = path.join(cacheDir, 'credentials.json');
  if (!fs.existsSync(credentialsFile)) {
    console.log('[Spotify Auth] No credentials found. Enabling device pairing via spotify.com/pair...');
    args.push('--enable-device-auth');
  }

  console.log(`[Audio Mode] librespot Direct Connect Endpoint`);
  console.log(`[Spotify] Launching librespot as "${deviceName}"...`);
  activeAudioProcess = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });

  const audioStream = new PassThrough();

  activeAudioProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    if (text.includes('spotify.com/pair') || text.includes('Browse to:')) {
      console.log('\n====================================================');
      console.log('       SPOTIFY DEVICE AUTHENTICATION REQUIRED       ');
      console.log('====================================================');
      console.log(text.trim());
      console.log('====================================================\n');
      return;
    }
    audioStream.write(chunk);
  });

  activeAudioProcess.stdout.on('end', () => audioStream.end());
  activeAudioProcess.stdout.on('error', (err) => audioStream.destroy(err));

  const resource = createAudioResource(audioStream, {
    inputType: StreamType.Raw,
    inlineVolume: true
  });

  audioPlayer.play(resource);

  audioPlayer.on(AudioPlayerStatus.Playing, () => {
    console.log('[Playback] Audio streaming to Discord voice channel.');
  });

  audioPlayer.on(AudioPlayerStatus.Idle, () => {
    console.log('[Playback] Audio stream paused/idle.');
  });

  audioPlayer.on('error', (err) => {
    console.error('[Playback Error]', err.message);
  });

  activeAudioProcess.on('error', (err) => {
    console.error('[Spotify] Process execution failed:', err.message);
  });

  activeAudioProcess.on('close', (code) => {
    console.log(`[Spotify] librespot exited with code ${code}.`);
  });
}

function listAudioDevices() {
  const binaryName = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
  let binaryPath = path.resolve(appDir, binaryName);
  if (!fs.existsSync(binaryPath)) {
    binaryPath = binaryName;
  }

  console.log('====================================================');
  console.log('       Scanning DirectShow Audio Devices            ');
  console.log('====================================================\n');

  let proc;
  try {
    proc = spawn(binaryPath, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    console.error(`Failed to execute "${binaryName}": ${err.message}`);
    process.exit(1);
  }

  let output = '';
  proc.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  proc.on('close', () => {
    console.log(output);
    console.log('----------------------------------------------------');
    console.log('Instructions:');
    console.log('1. Look under "DirectShow audio devices" above.');
    console.log('2. Set AUDIO_DEVICE_NAME="<Exact Device Name>" in your .env file.');
    console.log('   (Default: "CABLE Output (VB-Audio Virtual Cable)")');
    console.log('----------------------------------------------------\n');
    process.exit(0);
  });

  proc.on('error', (err) => {
    console.error(`[Error] ffmpeg execution error: ${err.message}`);
    process.exit(1);
  });
}

function cleanupAudioProcess() {
  if (activeAudioProcess) {
    try {
      activeAudioProcess.kill('SIGINT');
    } catch {
      // Process already terminated
    }
    activeAudioProcess = null;
  }
}

function cleanup() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  cleanupAudioProcess();
  if (voiceConnection) {
    try {
      voiceConnection.destroy();
    } catch {
      // Connection already destroyed
    }
    voiceConnection = null;
  }
}

process.on('SIGINT', () => {
  console.log('\n[Bot] Shutting down (SIGINT)...');
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[Bot] Shutting down (SIGTERM)...');
  cleanup();
  process.exit(0);
});

client.on('error', (err) => {
  console.error('[Discord Client Error]', err);
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('[Auth Error] Failed to login to Discord:', err.message);
  process.exit(1);
});
