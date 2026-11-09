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
const path = require('path');
const fs = require('fs');

// Support both standalone executable (pkg) and standard node execution
const isPkg = typeof process.pkg !== 'undefined';
const appDir = isPkg ? path.dirname(process.execPath) : process.cwd();

// Load .env from the application directory
require('dotenv').config({ path: path.join(appDir, '.env') });

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
let spotifyProcess = null;
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
    console.log('[Voice] Voice connection ready. Initializing Spotify pipe...');
    startSpotifyPipe();
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

function startSpotifyPipe() {
  if (spotifyProcess) {
    cleanupSpotifyProcess();
  }

  const isWindows = process.platform === 'win32';
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

  // Configure librespot parameters
  const args = [
    '--name', deviceName,
    '--backend', 'pipe',
    '--initial-volume', '100',
    '--bitrate', '320'
  ];

  if (process.env.SPOTIFY_USERNAME && process.env.SPOTIFY_PASSWORD) {
    args.push('-u', process.env.SPOTIFY_USERNAME, '-p', process.env.SPOTIFY_PASSWORD);
  }

  console.log(`[Spotify] Launching librespot endpoint as "${deviceName}"...`);
  spotifyProcess = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });

  // Stream raw PCM standard output into the Discord Audio Player
  const resource = createAudioResource(spotifyProcess.stdout, {
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

  spotifyProcess.on('error', (err) => {
    console.error('[Spotify] Process execution failed:', err.message);
  });

  spotifyProcess.on('close', (code) => {
    console.log(`[Spotify] librespot exited with code ${code}.`);
  });
}

function cleanupSpotifyProcess() {
  if (spotifyProcess) {
    try {
      spotifyProcess.kill('SIGINT');
    } catch {
      // Process already terminated
    }
    spotifyProcess = null;
  }
}

function cleanup() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  cleanupSpotifyProcess();
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

