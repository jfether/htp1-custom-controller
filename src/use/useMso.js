import { ref, watch, computed } from 'vue';
import { applyPatch, deepClone, compare } from 'fast-json-patch/index.mjs';
import { debounce, get } from 'lodash-es';

import useWebSocket from './useWebSocket.js';
import useLocalStorage from './useLocalStorage.js';
import useSpeakerGroups from './useSpeakerGroups.js';

// map upmix codes to labels,
// used internally by visibleUpmixers
const upmixLabels = {
  'off': 'Direct',
  'native': 'Native',
  'dolby': 'Dolby Surround',
  'dts': 'DTS Neural:X',
  'auro': 'Auro-3D',
  'mono': 'Mono',
  'stereo': 'Stereo'
}

const defaultPersonalizeShortcuts = {
  'about': true,
  'help': true,
  'power': true,
};

const defaultPersonalizeModes = {
  'dirac': true,
  'loudness': true,
  'dialogenh': true,
  'night': true,
};

const commandKeys = [
  'cmda',
  'cmdb',
  'cmdc',
  'cmdd',
  'preset1',
  'preset2',
  'preset3',
  'preset4'
];

// local MSO state, used to display values on the interface
const mso = ref({});

// list of commands to send to MSO based on user interactions
// interactions are debounced so commands for rapid interactions
// will be sent in bulk instead of individually
const commandsToSend = ref([]);

// list of commands received from MSO, which need to be applied to local state
const commandsReceived = ref([]);

// list of commands sent to MSO where a resonse has not yet been received
const commandsAwaitingResponse = ref([]);

const loading = ref(false);

// if recording is currently enabled for a slot,
// it will be stored here and a notice will be shown
const currentlyRecordingSlot = ref(null);

const { data, state, send, close } = useWebSocket();

const { getActiveChannels } = useSpeakerGroups();

const { maxWaitTimeToSendToMso } = useLocalStorage();

// watchers ------------------------------------------

// watch websocket messages and keep local mso state up to date
watch(
  data, 
  val => {
    const { verb, arg } = parseMSO(val);
    console.log('received verb', verb);
    if (verb === 'mso') {
      // full mso object
      mso.value = arg;
      applyProductRules();
      console.log(mso.value)
    } else if (verb === 'msoupdate') {
        // update received. only process received commands if commandsToSend is empty;
        // otherwise we will store the received commands and wait for the next update
        if (Array.isArray(arg)) {
          for (const cmd of arg) {
            commandsReceived.value = addCommand(commandsReceived.value, cmd);
          }
        } else {
          console.log('msoupdate non-array', arg)
          commandsReceived.value = addCommand(commandsReceived.value, arg);
        }
        
    } else if (verb === 'error') {
      // oh no
      console.log('error', arg);
    }

  },
  { lazy: true }
);

// watch websocket state, once open, send getmso to 
// retrieve full mso state to hold in local state
watch(
  state,
  val => {
    switch (val) {
      case 'OPEN':
        send('getmso');
        break;
      default:
        commandsAwaitingResponse.value = [];
    }
  }
);

// watch commandsToSend, add them to commandsAwaitingResponse
// triggers the commandsAwaitingResponse watcher
watch(
  commandsToSend,
  newCommandsToSend => {
    console.log('watch commandsToSend', newCommandsToSend.length, newCommandsToSend)
    if (newCommandsToSend.length > 0) {
      commandsAwaitingResponse.value = addCommandList(commandsAwaitingResponse.value, newCommandsToSend);
    }
  }
);

// watch commandsAwaitingResponse, if any are present, 
// debounce send commands to MSO
watch(
  commandsAwaitingResponse,
  newCommandsAwaitingResponse => {
    console.log('watch commandsAwaitingResponse', newCommandsAwaitingResponse.length)
    if (newCommandsAwaitingResponse.length > 0) {
      debouncedSendCommands.value();
      // sendCommands();
      loading.value = true;
    } else {
      loading.value = false;
    }
  }
);

// watch commandsReceived, and apply them to local MSO state
// after user interaction has stopped for x ms
watch(
  commandsReceived,
  newCommandsReceived => {
    if (newCommandsReceived.length > 0) {
      receiveCommands();
    }
  }
);

// helper functions for watchers ---------------------------
function applyProductRules() {

  const groups = ['c', 'lrs', 'lrb', 'lrw', 'lrtf', 'lrtm', 'lrtr', 'lrhf', 'lrhr', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5'];
  const spg = mso.value.speakers?.groups;

  if (spg) {
    for (const group of groups) {
      if (spg[group] === undefined) {
        initializeSpeakerGroup(group);
      }
    }

    // too many channels, disable speaker groups until under 16
    if (activeChannels.value.length > 16) {
      let over = activeChannels.value.length - 16;
      // iterate speaker groups in reverse order, 
      // excluding subs, so starting at index 8 = lrhr
      // and disable them until the total channel count <= 16
      for (let i = 8; i >= 0; i--) { 
        if (spg[groups[i]].present) {
          setSpeakerGroupPresent(groups[i], false);
          over -= 2;
        }
        
        // total channels is now 16 or less
        if (over <= 0) {
          break;
        }
      }
    }

    setSpeakerGroupPresent('lrb', spg.lrb.present && spg.lrs.present); // No backs when no surround
    setSpeakerGroupPresent('lrw', spg.lrw.present && spg.lrb.present); // No wides when no backs
    console.log('lrhf?', spg.lrhf.present && (!spg.lrtf.present));
    setSpeakerGroupPresent('lrhf', spg.lrhf.present && (!spg.lrtf.present)); // No height front if top front present

    if ((!spg.lrs.present) && (spg.lrtm.present) && (spg.lrtf.present || spg.lrtr.present || spg.lrhf.present || spg.lrhr.present)) {
        setSpeakerGroupPresent('lrtf', false);
        setSpeakerGroupPresent('lrtr', false);
        setSpeakerGroupPresent('lrhf', false);
        setSpeakerGroupPresent('lrhr', false);
    };
    if ((!spg.lrs.present) && (!spg.lrtm.present) && (spg.lrtr.present || spg.lrhr.present)) {
        setSpeakerGroupPresent('lrtf', spg.lrtf.present && (!spg.lrhf.present));
        setSpeakerGroupPresent('lrtr', false);
        setSpeakerGroupPresent('lrhr', false);
    };
    if ((!spg.c.present) && (!spg.lrb.present)) {
        setSpeakerGroupPresent('lrtm', false);
    };
    spg.lrtf.present = spg.lrtf.present && (!spg.lrhf.present); // only one front allowed
    spg.lrtr.present = spg.lrtr.present && (!spg.lrhr.present); // only one rear allowed
    if ((!spg.lrtf.present) && (!spg.lrhf.present)) {
        setSpeakerGroupPresent('lrhr', false); // no fronts . clear rears
        setSpeakerGroupPresent('lrtr', false);
    };
    // No top middle when top front present but top rear not present
    if (spg.lrtm.present && spg.lrtf.present) {
        if ((!spg.lrtr.present) && (!spg.lrhr.present)) {
            setSpeakerGroupPresent('lrtm', false);
        }
    }
    if (spg.lrtm.present && spg.lrhf.present) {
        if ((!spg.lrtr.present) && (!spg.lrhr.present)) {
            setSpeakerGroupPresent('lrtm', false);
        }
    }

    setSpeakerGroupPresent('sub2', spg.sub2.present && spg.sub1.present); // No sub2 without sub
    setSpeakerGroupPresent('sub3', spg.sub3.present && spg.sub2.present); // No sub3 without sub2
    setSpeakerGroupPresent('sub4', spg.sub4.present && spg.sub3.present); // No sub4 without sub3
    setSpeakerGroupPresent('sub5', spg.sub5.present && spg.sub4.present); // No sub5 without sub4

    for (const groupName of Object.keys(spg)) {
      const group = spg[groupName];
      if (group.fc) {
        setCenterFreq(groupName, Math.round(group.fc / 10) * 10);
      };
    }

    if (mso.value.fastStart === 'off') {
        setFastStartPassThroughOff();
    };

    // initialize custom attributes if not present
    if (!mso.value.sgen.select2) {
      _setSignalGeneratorChannel2();
    }

    for (let inputKey in mso.value.inputs) {
      if (mso.value.inputs) {
        if (!mso.value.inputs[inputKey].hasOwnProperty('defaultUpmix')) {
          _setInputDefaultUpmix(inputKey);
        }
        if (!mso.value.inputs[inputKey].hasOwnProperty('gain')) {
          _setInputVolumeTrim(inputKey);
        }
      }
    }

    if (!mso.value.loudnessCurve) {
      _setLoudnessCurve();
    }

    if (!mso.value.personalize) {
      initializePersonalize();
    } else {
      if (!mso.value.personalize.shortcuts) {
        initializeShortcuts();
      }

      if (!mso.value.personalize.modes) {
        initializeModes();
      }

      if (!mso.value.personalize.diracSlots) {
        initializeDiracSlots();
      }

      if (!mso.value.personalize.macros) {
        initializeShowMacros();
      }

      if (!mso.value.personalize.dismissedAlerts) {
        initializeDismissedAlerts();
      }
    }

    if (!mso.value.svronly.macroNames) {
      initializeMacroNames();
    }
  }
}

function patchMso(singlePatch) {
  // block changes if dirac calibration is in progress
  if (!calToolConnected.value) {

    // check if patch already matches local mso state
    const oldValue = get(mso.value, singlePatch.path.substring(1).split('/'));
    if (oldValue === singlePatch.value) {
      return false;
    }

    console.log('patchMso', singlePatch);

    // update local mso state
    applyPatch(mso.value, [singlePatch]);
    // add to commandsToSend, which will trigger its
    // watcher and queue it to be sent to the mso websocket
    commandsToSend.value = addCommand(commandsToSend.value, singlePatch);
    return true;
  }

  return false;
}

function sendCommands() {
  console.log('sendCommands', commandsToSend, commandsAwaitingResponse)
  if (commandsToSend.value.length > 0) {
    console.log('changemso', commandsToSend.value.length, commandsToSend.value[0]);
    // send('changemso ' + JSON.stringify(commandsToSend.value));
    changemso(commandsToSend.value)
    commandsToSend.value = [];
  }
}

function changemso(commands) {
  send('changemso ' + JSON.stringify(commands));
}

// // send commands 250 ms after user interaction stopped
// const debouncedSendCommands = debounce(sendCommands, 250, {
//   // use a max wait time of 300 ms, so the user does see
//   // their interactions cause changes every 300 ms at maximum
//   // if the user rapidly adjusts volume from -50 dB to 0 dB,
//   // this allows the volume to gradually increase around every 
//   // 3 dB, instead of only suddenly updating the volume to 0 dB
//   // at the end
//   maxWait: 100,
//   leading: true,
//   trailing: true
// });

const debouncedSendCommands = computed(() => {
  return debounce(sendCommands, 250, {
    maxWait: maxWaitTimeToSendToMso.value,
    leading: true,
    trailing: true,
  });
});

function receiveCommands() {
  if (commandsReceived.value.length > 0) {
    console.log('receiveCommands', commandsReceived.value.length, commandsReceived.value[0]);
    
    if (commandsReceived.value.length > 0) {

      commandsAwaitingResponse.value = filterMatchingCommandList(
        commandsAwaitingResponse.value, commandsReceived.value
      );

      // only apply patch if not awaiting any more commands
      if (commandsAwaitingResponse.value.length === 0) {
        console.log('!!!! applyPatch', commandsReceived.value)
        
        // use this to trigger mso watcher, 
        // requires deep clone for every mso mutation
        // const newMso = deepClone(mso.value);
        // applyPatch(newMso, commandsReceived.value);
        // mso.value = newMso;

        // this does not trigger mso watcher
        // but does not require deep clone, so it's 
        // more lightweight if mso watcher isn't needed
        applyPatch(mso.value, commandsReceived.value);


        commandsReceived.value = [];

        applyProductRules();

      } else {
        console.log('skip applyPatch', commandsAwaitingResponse.value)
      }
    }

  } else {
    console.log('skip receiveCommands', commandsToSend.value.length, commandsReceived.value.length);
  }
}

// mso computed getters ------------------------------------

// loading indicator, when commands have been 
// sent to MSO and a response is being awaited
// const loading = computed(() => commandsAwaitingResponse.value.length > 0);

// visible MSO inputs, computed from MSO state
const visibleInputs = computed(() => {
  const filtered = {};
  if (mso.value.inputs) {
    for (const inpKey in mso.value.inputs) {
      if (mso.value.inputs[inpKey].visible) {
        filtered[inpKey] = mso.value.inputs[inpKey];
      }
    }
  }
  return filtered;
});

// visible upmixers, computed from MSO state
const visibleUpmixers = computed(() => {
  const filtered = {};
  if (mso.value.upmix) {
    for (const upmixKey in mso.value.upmix) {
      if (mso.value.upmix[upmixKey].homevis) {
        filtered[upmixKey] = {...mso.value.upmix[upmixKey]};
        filtered[upmixKey].label = upmixLabels[upmixKey];
      }
    }
  }

  return filtered;
});

const visibleDiracSlots = computed(() => {
  const filtered = {};
  if (mso.value.personalize?.diracSlots) {
    for (let slotIndex in mso.value.personalize?.diracSlots) {
      filtered[slotIndex] = mso.value.cal?.slots[slotIndex];
    }
  }
  return filtered;
});

const visibleMacros = computed(() => {
  const filtered = {};
  if (mso.value.personalize?.macros) {
    for (let key in mso.value.personalize?.macros) {
      filtered[key] = mso.value.svronly[key];
    }
  }
  console.log('visibleMacros', visibleMacros)
  return filtered;
});

const allUpmixers = computed(() => {
  const filtered = {};
  if (mso.value.upmix) {
    for (const upmixKey in mso.value.upmix) {
      if (typeof mso.value.upmix[upmixKey] === 'object') {
        filtered[upmixKey] = mso.value.upmix[upmixKey];
        filtered[upmixKey].label = upmixLabels[upmixKey];
        filtered[upmixKey].value = upmixKey;
      }
    }
  }

  return filtered;
});

const currentDiracSlot = computed(() => {
  return mso.value.cal?.slots[mso.value.cal?.currentdiracslot];
});

const diracBCEnabled = computed(() => {
  return mso.value.cal?.slots[mso.value.cal?.currentdiracslot].hasBCFilter;
});

const showCrossoverControls = computed(() => {
  return !(mso.value.cal?.diracactive=='on' && diracBCEnabled.value);
});

const calToolConnected = computed(() => {
  return mso.value.cal?.caltoolconnected;
});

const activeChannels = computed(() => {
  return getActiveChannels(mso.value.speakers?.groups);
});

// mso mutators --------------------------------------------

function powerOff() {
  // TODO show a bootstrap modal instead
  if (confirm("The power will be turned off.")) {
    const commands = [];

    // set default upmix for current input if necessary
    const defaultUpmix = mso.value.inputs[mso.value.input].defaultUpmix;
    if (defaultUpmix && mso.value?.upmix.select !== defaultUpmix) {
      commands.push(
        {'op':'replace', 'path': '/upmix/select', 'value': defaultUpmix}
      );
    }

    commands.push({'op':'replace', 'path': '/powerIsOn', 'value': false});

    commandsToSend.value = commands;
  }

  return true;
}

function powerOn() {
  commandsToSend.value = [
    {'op':'replace', 'path': '/powerIsOn', 'value': true}
  ];

  return true;
}

function setVolume(volumeLevel) {
  if (volumeLevel < mso.value.cal?.vpl) {
    volumeLevel = mso.value.cal?.vpl;
  }

  if (volumeLevel > mso.value.cal?.vph) {
    volumeLevel = mso.value.cal?.vph;
  }

  return patchMso({'op':'replace', 'path': '/volume', 'value': volumeLevel});
}

function toggleMute() {
  return patchMso({'op':'replace', 'path': '/muted', 'value': !mso.value.muted});
}

function setInput(inpid) {
  // caution: test erase video resolution from local MSO only
  // it should be corrected once the new input has been selected
  // only do this when switching to HDMI
  if (inpid !== mso.value.input) {
    if (inpid.startsWith('h') && mso.value.input.startsWith('h')) {
      mso.value.videostat.VideoResolution = '-----';
      mso.value.videostat.VideoColorSpace = '---';
      mso.value.videostat.VideoMode = '--';
      mso.value.videostat.HDRstatus = '--';
      mso.value.videostat.VideoBitDepth = '--';
      mso.value.videostat.Video3D = '--';
    }
    return patchMso({'op':'replace', 'path': '/input', 'value': inpid});
  }
  return false;
}

function setUpmix(upmixKey) {
  return patchMso({'op':'replace', 'path': '/upmix/select', 'value': upmixKey});
}

function toggleUpmixHomevis(upmix) {
  return patchMso({'op':'replace', 'path': `/upmix/${upmix}/homevis`, 'value': !mso.value.upmix[upmix].homevis});
}

function toggleUpmixCenterSpread() {
  return patchMso({'op':'replace', 'path': `/upmix/dolby/cs`, 'value': !mso.value.upmix.dolby.cs});
}

function toggleUpmixWideSynth() {
  return patchMso({'op':'replace', 'path': `/upmix/dts/ws`, 'value': !mso.value.upmix.dts.ws});
}

function setUpmixWideSynthOn() {
  return patchMso({'op':'replace', 'path': `/upmix/dts/ws`, 'value': true});
}

function setUpmixWideSynthOff() {
  return patchMso({'op':'replace', 'path': `/upmix/dts/ws`, 'value': false});
}

function setAuroMaticPreset(preset) {
  return patchMso({'op':'replace', 'path': `/upmix/auro/preset`, 'value': parseInt(preset)});
}

function setAuroMaticStrength(strength) {
  return patchMso({'op':'replace', 'path': `/upmix/auro/strength`, 'value': parseInt(strength)});
}

function setDefaultAuroMaticStrength() {
  setAuroMaticStrength(13);
}

function toggleReinforceBass() {
  if (!diracBCEnabled.value) {
    return patchMso({'op':'replace', 'path': `/bassenhance`, 'value': mso.value.bassenhance === 'off' ? 'on' : 'off'});
  }
}

function setReinforceBassOff() {
  return patchMso({'op':'replace', 'path': `/bassenhance`, 'value': 'off'});
}

function setReinforceBassOn() {
  if (!diracBCEnabled.value) {
    return patchMso({'op':'replace', 'path': `/bassenhance`, 'value': 'on'});
  }
}

function setNextNightMode() {

  let nightValue;

  switch(mso.value.night) {
    case 'auto':
      nightValue = 'on';
      break;
    case 'off':
      nightValue = 'auto';
      break;
    default:
    case 'on':
      nightValue = 'off';
  }

  return patchMso({'op':'replace', 'path': '/night', 'value': nightValue});
}

function setNightOn() {
  return patchMso({'op':'replace', 'path': '/night', 'value': 'on'});
}

function setNightAuto() {
  return patchMso({'op':'replace', 'path': '/night', 'value': 'auto'});
}

function setNightOff() {
  return patchMso({'op':'replace', 'path': '/night', 'value': 'off'});
}

function toggleDirac() {

  let diracActive;

  switch(mso.value.cal.diracactive) {
    case 'on':
      diracActive = 'bypass';
      break;
    case 'off':
      diracActive = 'on';
      break;
    default:
    case 'bypass':
      diracActive = 'off';
      break;
  }

  return patchMso({'op':'replace', 'path': '/cal/diracactive', 'value': diracActive});
}

function setDiracOn() {
  return patchMso({'op':'replace', 'path': '/cal/diracactive', 'value': 'on'});
}

function setDiracBypass() {
  return patchMso({'op':'replace', 'path': '/cal/diracactive', 'value': 'bypass'});
}

function setDiracOff() {
  return patchMso({'op':'replace', 'path': '/cal/diracactive', 'value': 'off'});
}

function toggleLoudness() {
  return patchMso({'op':'replace', 'path': '/loudness', 'value': mso.value.loudness === 'off' ? 'on' : 'off'});
}

function setLoudnessOn() {
  return patchMso({'op':'replace', 'path': '/loudness', 'value': 'on'});
}

function setLoudnessOff() {
  return patchMso({'op':'replace', 'path': '/loudness', 'value': 'off'});
}

function setNextDtsDialogEnh() {
  return patchMso({'op':'replace', 'path': '/dialogEnh', 'value': (mso.value.dialogEnh + 1) % 7});
}

function setDtsDialogEnh(level) {
  return patchMso({'op':'replace', 'path': '/dialogEnh', 'value': parseInt(level)});
}

function toggleSpeakerGroup(spkCode) {
  return patchMso({'op': 'replace', 'path': `/speakers/groups/${spkCode}/present`, value: !mso.value.speakers.groups[spkCode].present});
}

function setSpeakerGroupPresent(spkCode, present) {
  return patchMso({'op': 'replace', 'path': `/speakers/groups/${spkCode}/present`, value: present});
}

function initializeSpeakerGroup(spkCode) {
  // TODO does this work?
  return patchMso({'op': 'add', 'path': `/speakers/groups/${spkCode}`, value: { present: false, size: 'l', fc: 40 }});
}

function setSpeakerSize(spkCode, sizeCode) {
  return patchMso({'op': 'replace', 'path': `/speakers/groups/${spkCode}/size`, value: sizeCode});
}

function setCenterFreq(spkCode, centerFreq) {
  return patchMso({'op': 'replace', 'path': `/speakers/groups/${spkCode}/fc`, value: parseInt(centerFreq)});
}

function setMinVolume(minVol) {
  return patchMso({'op': 'replace', 'path': '/cal/vpl', value: parseInt(minVol)});
}

function setMaxVolume(maxVol) {
  return patchMso({'op': 'replace', 'path': '/cal/vph', value: parseInt(maxVol)});
}

function setMaxOutputLevel(outputLevel) {
  return patchMso({'op': 'replace', 'path': '/cal/ampsense', value: parseFloat(outputLevel)});
}

function setLipsyncDelay(lipsyncDelay) {
  return patchMso({'op': 'replace', 'path': '/cal/lipsync', value: parseInt(lipsyncDelay)});
}

function setDiracSlot(slotNumber) {
  return patchMso({'op': 'replace', 'path': '/cal/currentdiracslot', value: parseInt(slotNumber)});
}

function setUserDelay(channel, delay) {
  return patchMso({'op': 'replace', 'path': `/cal/slots/${mso.value.cal.currentdiracslot}/channels/${channel}/delay`, value: parseFloat(delay)});
}

function setUserTrim(channel, trim) {
  return patchMso({'op': 'replace', 'path': `/cal/slots/${mso.value.cal.currentdiracslot}/channels/${channel}/trim`, value: parseFloat(trim)});
}

function setMuteChannelOn(channel) {
  if (currentDiracSlot.value.channels[channel].mute === undefined) {
    // save existing user trim so it can be restored on unmute
    const preMuteTrim = patchMso({'op': 'add', 'path': `/cal/slots/${mso.value.cal.currentdiracslot}/channels/${channel}/preMuteTrim`, 
      value: currentDiracSlot.value.channels[channel].trim});
    // set mute flag to true
    const mute =  patchMso({'op': 'add', 'path': `/cal/slots/${mso.value.cal.currentdiracslot}/channels/${channel}/mute`, value: true});
    // apply -100 trim to achieve mute effect
    const trim = setUserTrim(channel, -100);

    return preMuteTrim && mute && trim;
  }

  return false;
}

function setMuteChannelOff(channel) {
  if (currentDiracSlot.value.channels[channel].mute === true) {
    // restore user trim 
    let trim;
    if (currentDiracSlot.value.channels[channel].preMuteTrim) {
      trim = setUserTrim(channel, currentDiracSlot.value.channels[channel].preMuteTrim);
    } else {
      trim = setUserTrim(channel, 0);
    }
    
    // remove mute flag
    const mute =  patchMso({'op': 'remove', 'path': `/cal/slots/${mso.value.cal.currentdiracslot}/channels/${channel}/mute`});
    // remove saved user trim
    const preMuteTrim =  patchMso({'op': 'remove', 'path': `/cal/slots/${mso.value.cal.currentdiracslot}/channels/${channel}/preMuteTrim`});

    return trim && mute && preMuteTrim;
  }

  return false;
}

function toggleMuteChannel(channel) {
  if (currentDiracSlot.value.channels[channel].mute) {
    return setMuteChannelOff(channel);
  }

  return setMuteChannelOn(channel);
}

function setMuteAllChannelsOn() {
  let result = true;
  for (let channel in currentDiracSlot.value.channels) {
    result = setMuteChannelOn(channel) && result;
  }

  return result;
}

function setMuteAllChannelsOff() {
  let result = true;
  for (let channel in currentDiracSlot.value.channels) {
    result = setMuteChannelOff(channel) && result;
  }

  return result;
}

function toggleAllMuteChannels() {
  let result = true;
  for (let channel in currentDiracSlot.value.channels) {
    result = toggleMuteChannel(channel) && result;
  }

  return result;
}

function toggleSignalGenerator() {
  return patchMso({'op': 'replace', 'path': `/sgen/sgensw`, value: mso.value.sgen.sgensw === 'off' ? 'on' : 'off'});
}

function setSignalGeneratorOff() {
  return patchMso({'op': 'replace', 'path': `/sgen/sgensw`, value: 'off'});
}

function setSignalGeneratorOn() {
  return patchMso({'op': 'replace', 'path': `/sgen/sgensw`, value: 'on'});
}

function setSignalGeneratorChannel(channel) {
  return patchMso({'op': 'replace', 'path': `/sgen/select`, value: channel});
}

function _setSignalGeneratorChannel2(channel, op) {
  if (!op) {
    op = mso.value.sgen?.select2 ? 'replace' : 'add';
  }

  if (!channel) {
    channel = 'rf';
  }
  
  return patchMso({'op': op, 'path': `/sgen/select2`, value: channel});
}

// Warning: custom attribute
function setSignalGeneratorChannel2(channel) {
  return _setSignalGeneratorChannel2(channel, 'replace');
}

function setSignalGeneratorSignalType(signalType) {
  return patchMso({'op': 'replace', 'path': `/sgen/signalType`, value: signalType});
}

function setSineFrequency(freq) {
  let freqValue = parseInt(freq);
  if (isNaN(freqValue)) {
    freqValue = 440;
  } else if (freqValue < 10) {
    freqValue = 10;
  } else if (freqValue > 20000) {
    freqValue = 20000;
  }
  return patchMso({'op': 'replace', 'path': `/sgen/sinehz`, value: freqValue});
}

function setSineAmplitude(gain) {
  let gainValue = parseFloat(gain);
  if (isNaN(gainValue)) {
    gainValue = -20;
  } else if (gainValue < -140) {
    gainValue = -140;
  } else if (gainValue > 0) {
    gainValue = 0;
  }
  return patchMso({'op': 'replace', 'path': `/sgen/sinedb`, value: gainValue});
}

function toggleToneControl() {
  return patchMso({'op': 'replace', 'path': `/eq/tc`, value: !mso.value.eq.tc});
}

function setToneControlOn() {
  return patchMso({'op': 'replace', 'path': `/eq/tc`, value: true});
}

function setToneControlOff() {
  return patchMso({'op': 'replace', 'path': `/eq/tc`, value: false});
}

function setBassCornerFrequency(freq) {
  return patchMso({'op': 'replace', 'path': `/eq/bass/freq`, value: parseFloat(freq)});
}

function setTrebleCornerFrequency(freq) {
  return patchMso({'op': 'replace', 'path': `/eq/treble/freq`, value: parseFloat(freq)});
}

function setBassBoostCutLevel(level) {
  return patchMso({'op': 'replace', 'path': `/eq/bass/level`, value: parseFloat(level)});
}

function setTrebleBoostCutLevel(level) {
  return patchMso({'op': 'replace', 'path': `/eq/treble/level`, value: parseFloat(level)});
}

function setLoudnessCalibration(loudness) {
  return patchMso({'op': 'replace', 'path': `/loudnessCal`, value: parseFloat(loudness)});
}

// warning: custom attribute
function _setLoudnessCurve(op, curve) {
  if (!op) {
    op = mso.value.loudnessCurve ? 'replace' : 'add';
  }
  
  if (curve !== 'iso' && curve !== 'vintage') {
    curve = 'iso';
  }

  return patchMso({'op': op, 'path': `/loudnessCurve`, value: curve});
}

function setLoudnessCurve(curve) {
  return _setLoudnessCurve('replace', curve);
}

function toggleGlobalPEQ() {
  return patchMso({'op': 'replace', 'path': `/peq/peqsw`, value: !mso.value.peq.peqsw});
}

function setGlobalPEQOn() {
  return patchMso({'op': 'replace', 'path': `/peq/peqsw`, value: true});
}

function setGlobalPEQOff() {
  return patchMso({'op': 'replace', 'path': `/peq/peqsw`, value: false});
}

function setPEQSlot(bandNumber) {
  return patchMso({'op': 'replace', 'path': `/peq/currentpeqslot`, value: parseInt(bandNumber)});
}

function setPEQCenterFrequency(channel, slot, centerFreq) {

  let centerFreqValue = parseFloat(centerFreq);

  if (isNaN(centerFreqValue)) {
    centerFreqValue = 100.0;
  } else if (centerFreqValue < 15.0) {
    centerFreqValue = 15.0;
  } else if (centerFreqValue > 20000.0) {
    centerFreqValue = 20000.0;
  }

  return patchMso({'op': 'replace', 'path': `/peq/slots/${slot}/channels/${channel}/Fc`, value: centerFreqValue});
}

function setPEQGain(channel, slot, gain) {

  let gainValue = parseFloat(gain);

  if (isNaN(gainValue)) {
    gainValue = 0.0;
  } else if (gainValue < -20.0) {
    gainValue = -20.0;
  } else if (gainValue > 20.0) {
    gainValue = 20.0;
  }

  return patchMso({'op': 'replace', 'path': `/peq/slots/${slot}/channels/${channel}/gaindB`, value: gainValue});
}

function setPEQQuality(channel, slot, q) {

  let qValue = parseFloat(q);

  if (isNaN(qValue)) {
    qValue = 1.0;
  } else if (qValue < 0.1) {
    qValue = 0.1;
  } else if (qValue > 10.0) {
    qValue = 10.0;
  }

  return patchMso({'op': 'replace', 'path': `/peq/slots/${slot}/channels/${channel}/Q`, value: qValue});
}

function setPEQFilterType(channel, slot, filterType) {
  return patchMso({'op': 'replace', 'path': `/peq/slots/${slot}/channels/${channel}/FilterType`, value: parseInt(filterType)});
}

function resetPEQ(channel, slot) {

  const fc = setPEQCenterFrequency(channel, slot, 100);
  const gain = setPEQGain(channel, slot, 0);
  const q = setPEQQuality(channel, slot, 1);
  const filterType = setPEQFilterType(channel, slot, 0);

  return fc && gain && q && filterType;
}

function setInputLabel(input, label) {
  return patchMso({'op': 'replace', 'path': `/inputs/${input}/label`, value: label});
}

function toggleInputVisible(input) {
  return patchMso({'op': 'replace', 'path': `/inputs/${input}/visible`, value: !mso.value.inputs[input].visible});
}

function setInputFormatDetectOption(input, formatDetectOption) {
  return patchMso({'op': 'replace', 'path': `/inputs/${input}/formatDetectOption`, value: formatDetectOption});
}

// Warning: custom attribute
function _setInputDefaultUpmix(input, defaultUpmix, op) {
  if (!op) {
    op = mso.value.inputs[input].hasOwnProperty('defaultUpmix') ? 'replace' : 'add';
  }

  if (!allUpmixers.value[defaultUpmix]) {
    defaultUpmix = null;
  }

  return patchMso({'op': op, 'path': `/inputs/${input}/defaultUpmix`, value: defaultUpmix});
}

function setInputDefaultUpmix(input, defaultUpmix) {
  return _setInputDefaultUpmix(input, defaultUpmix, 'replace');
}

function _setInputVolumeTrim(input, trim, op) {
  if (!op) {
    op = mso.value.inputs[input].hasOwnProperty('gain') ? 'replace' : 'add';
  }
  
  let trimValue = parseInt(trim);
  if (isNaN(trimValue)) {
    trimValue = 0;
  } else if (trimValue > 12) {
    trimValue  = 12;
  } else if (trimValue < -12) {
    trimValue = -12;
  }
  return patchMso({'op': 'replace', 'path': `/inputs/${input}/gain`, value: trimValue});
}

// Warning: custom attribute
function setInputVolumeTrim(input, trim) {
  return _setInputVolumeTrim(input, trim, 'replace');
}

function toggleInputUHD(input) {
  return patchMso({'op': 'replace', 'path': `/inputs/${input}/uhd`, value: !mso.value.inputs[input].uhd});
}

function setBluetoothDiscoverableTime(time) {
  return patchMso({'op': 'replace', 'path': `/bluetooth/discoverabletime`, value: parseInt(time)});
}

function enableBluetoothDiscovery() {
  send('btdiscover ' + mso.value.bluetooth.discoverabletime);
}

function toggleCEC() {
  return patchMso({'op': 'replace', 'path': `/CEC/cecOnSw`, value: mso.value.CEC.cecOnSw === 'off' ? 'on' : 'off'});
}

function setCECOn() {
  return patchMso({'op': 'replace', 'path': `/CEC/cecOnSw`, value: 'on'});
}

function setCECOff() {
  return patchMso({'op': 'replace', 'path': `/CEC/cecOnSw`, value: 'off'});
}

function setTVSoundSrcDefault(inp) {
  return patchMso({'op': 'replace', 'path': `/stat/TVSoundSrcDefault`, value: inp});
}

function toggleCECAllowPowerKey() {
  return patchMso({'op': 'replace', 'path': `/CEC/allowpwrk`, value: !mso.value.CEC.allowpwrk});
}

function toggleCECAllowVolKey() {
  return patchMso({'op': 'replace', 'path': `/CEC/allowvolk`, value: !mso.value.CEC.allowvolk});
}

function toggleCECAllowSysAudioOff() {
  return patchMso({'op': 'replace', 'path': `/CEC/allowsaf`, value: !mso.value.CEC.allowsaf});
}

function toggleCECAllowInputChange() {
  return patchMso({'op': 'replace', 'path': `/CEC/allowinp`, value: !mso.value.CEC.allowinp});
}

function toggleCECAllowStandby() {
  return patchMso({'op': 'replace', 'path': `/CEC/allowstdb`, value: !mso.value.CEC.allowstdb});
}

function setUnitName(name) {
  return patchMso({'op': 'replace', 'path': `/unitname`, value: name});
}

function toggleFastStart() {
  return patchMso({'op': 'replace', 'path': `/fastStart`, value: mso.value.fastStart === 'off' ? 'on' : 'off'});
}

function toggleFastStartPassThrough() {
  return patchMso({'op': 'replace', 'path': `/fastStartPassThrough`, value: mso.value.fastStartPassThrough === 'off' ? 'on' : 'off'});
}

function setFastStartPassThroughOff() {
  return patchMso({'op': 'replace', 'path': `/fastStartPassThrough`, value: 'off'});
}

function setFastStartPassThroughOn() {
  return patchMso({'op': 'replace', 'path': `/fastStartPassThrough`, value: 'on'});
}

function setFastStartOn() {
  return patchMso({'op': 'replace', 'path': `/fastStart`, value: 'on'});
}

function setFastStartOff() {
  return patchMso({'op': 'replace', 'path': `/fastStart`, value: 'off'});
}

function setPowerOnVol(volumeLevel) {
  return patchMso({'op': 'replace', 'path': `/powerOnVol`, value: parseInt(volumeLevel)});
}

function setFrontPanelBrightness(brightness) {
  return patchMso({'op': 'replace', 'path': `/hw/fpBright`, value: parseInt(brightness)});
}

function toggleVideoStatusHomePage() {
  return patchMso({'op': 'replace', 'path': `/stat/displayVideoStat`, value: !mso.value.stat.displayVideoStat});
}

function toggleExtendedAudioStatus() {
  return patchMso({'op': 'replace', 'path': `/stat/displayAudioStat`, value: !mso.value.stat.displayAudioStat});
}

function toggleAdvancedInputSettings() {
  return patchMso({'op': 'replace', 'path': `/stat/displayAdvancedSettings`, value: !mso.value.stat.displayAdvancedSettings});
}

function toggleSupportTools() {
  return patchMso({'op': 'replace', 'path': `/stat/enableSupportTools`, value: !mso.value.stat.enableSupportTools});
}

function initializePersonalize() {
  return patchMso({'op': 'add', 'path': '/personalize', value: {
    shortcuts: defaultPersonalizeShortcuts,
    modes: defaultPersonalizeModes
  }});
}

function initializeShortcuts() {
  return patchMso({'op': 'add', 'path': '/personalize/shortcuts', value: defaultPersonalizeShortcuts});
}

function initializeModes() {
  return patchMso({'op': 'add', 'path': '/personalize/modes', value: defaultPersonalizeModes});
}

function initializeDiracSlots() {
  return patchMso({'op': 'add', 'path': '/personalize/diracSlots', value: {}});
}

function initializeShowMacros() {
  return patchMso({'op': 'add', 'path': '/personalize/macros', value: {}});
}

function initializeDismissedAlerts() {
  return patchMso({'op': 'add', 'path': '/personalize/dismissedAlerts', value: {}});
}

function dismissAlert(alertKey) {
  return patchMso({'op': 'add', 'path': `/personalize/dismissedAlerts/${alertKey}`, value: true});
}

function resetDismissedAlerts() {
  return patchMso({'op': 'replace', 'path': `/personalize/dismissedAlerts`, value: {}});
}

function toggleShortcut(item) {

  const path = `/personalize/shortcuts/${item}`;

  if (mso.value.personalize.shortcuts[item]) {
    return patchMso({'op': 'remove', 'path': path});
  } else {
    return patchMso({'op': 'add', 'path': path, value: true});
  }
}

function toggleShowMode(mode) {

  const path = `/personalize/modes/${mode}`;

  if (mso.value.personalize.modes[mode]) {
    return patchMso({'op': 'remove', 'path': path});
  } else {
    return patchMso({'op': 'add', 'path': path, value: true});
  }
}

function toggleShowDiracSlot(slot) {
  const path = `/personalize/diracSlots/${slot}`;

  if (mso.value.personalize.diracSlots[slot]) {
    return patchMso({'op': 'remove', 'path': path});
  } else {
    return patchMso({'op': 'add', 'path': path, value: true});
  }
}

function toggleShowMacro(key) {
  const path = `/personalize/macros/${key}`;

  if (mso.value.personalize.macros[key]) {
    return patchMso({'op': 'remove', 'path': path});
  } else {
    return patchMso({'op': 'add', 'path': path, value: true});
  }
}

function executeMacro(macro) {
  let result = true;
  for (const cmd of macro) {
    result = patchMso(cmd) && result;
  }

  return result;
}

function initializeMacroNames() {
  return patchMso({'op': 'add', 'path': '/svronly/macroNames', value: {
    'cmda': 'CMD A',
    'cmdb': 'CMD B',
    'cmdc': 'CMD C',
    'cmdd': 'CMD D',
    'preset1': 'Preset 1',
    'preset2': 'Preset 2',
    'preset3': 'Preset 3',
    'preset4': 'Preset 4',
  }});
}

function setMacroName(macroKey, name) {
  return patchMso({'op': 'replace', 'path': `/svronly/macroNames/${macroKey}`, value: name});
}

function saveRecordedCommands(slot, commands) {
  if (!mso.value.svronly) {
    return false;
  }

  // patchMso({'op': 'replace', 'path': `/svronly/${slot}`, value: [...mso.value.svronly[slot], ...commands]});
  changemso([{'op': 'replace', 'path': `/svronly/${slot}`, value: commands}]);
  send('getmso');
  return true;
}

// danger
function importMsoPatchList(patchList) {
  commandsToSend.value = patchList;
}

// other state mutators
function setRecordingStarted(slot) {
  currentlyRecordingSlot.value = slot;
}

function setRecordingStopped() {
  currentlyRecordingSlot.value = null;
}

/**
* Composition function which exposes the MSO state, as well 
* as an API to interact with MSO, abstracting away all 
* websocket interactions to keep components clean.
*/
export default function useMso() {

  return { 
    mso, visibleInputs, visibleUpmixers, visibleDiracSlots, 
    visibleMacros, allUpmixers, upmixLabels,
    powerOff, powerOn,
    setVolume, toggleMute, setInput, setUpmix, 
    toggleUpmixHomevis, toggleUpmixCenterSpread, toggleUpmixWideSynth,
    setUpmixWideSynthOff, setUpmixWideSynthOn,
    setAuroMaticPreset, setAuroMaticStrength, setDefaultAuroMaticStrength,
    toggleReinforceBass, setReinforceBassOn, setReinforceBassOff,
    setNextNightMode, toggleDirac, toggleLoudness, setNextDtsDialogEnh,
    setDiracOff, setDiracBypass, setDiracOn,
    setNightOff, setNightAuto, setNightOn,
    setLoudnessOff, setLoudnessOn,
    setToneControlOff, setToneControlOn,
    toggleSpeakerGroup, setSpeakerSize, setCenterFreq,
    setMinVolume, setMaxVolume, setMaxOutputLevel, setLipsyncDelay, setDiracSlot,
    setUserDelay, setUserTrim, toggleMuteChannel,
    setMuteAllChannelsOff, setMuteAllChannelsOn, toggleAllMuteChannels,
    toggleSignalGenerator, setSignalGeneratorOff, setSignalGeneratorOn,
    setSignalGeneratorChannel, setSignalGeneratorChannel2, setSignalGeneratorSignalType,
    setSineFrequency, setSineAmplitude,
    toggleToneControl, setBassCornerFrequency, setTrebleCornerFrequency, 
    setBassBoostCutLevel, setTrebleBoostCutLevel, setLoudnessCalibration, setLoudnessCurve,
    toggleGlobalPEQ, setGlobalPEQOff, setGlobalPEQOn,
    setPEQSlot, setPEQCenterFrequency, setPEQGain, 
    setPEQQuality, setPEQFilterType, resetPEQ,
    setInputLabel, toggleInputVisible, setInputFormatDetectOption, toggleInputUHD, 
    setInputDefaultUpmix, setInputVolumeTrim,
    setBluetoothDiscoverableTime, enableBluetoothDiscovery,
    toggleCEC, setCECOff, setCECOn,
    setTVSoundSrcDefault, toggleCECAllowPowerKey, toggleCECAllowVolKey, 
    toggleCECAllowSysAudioOff, toggleCECAllowInputChange, toggleCECAllowStandby,
    toggleFastStart, setFastStartOff, setFastStartOn,
    toggleFastStartPassThrough, setFastStartPassThroughOff, setFastStartPassThroughOn,
    setUnitName, setPowerOnVol,
    setFrontPanelBrightness, toggleVideoStatusHomePage, toggleExtendedAudioStatus,
    toggleAdvancedInputSettings, toggleSupportTools, importMsoPatchList,
    saveRecordedCommands,
    toggleShortcut, toggleShowMode, toggleShowDiracSlot, toggleShowMacro,
    setMacroName, commandKeys, executeMacro,
    showCrossoverControls, currentDiracSlot, calToolConnected, activeChannels,
    currentlyRecordingSlot, setRecordingStarted, setRecordingStopped,
    dismissAlert, resetDismissedAlerts,
    state, loading,
    parseMSO, data,
    commandsToSend, commandsReceived, commandsAwaitingResponse // debug
  };
}

// helper to parse MSO message into verb and argument object
function parseMSO(cmd) {
  const i = cmd.indexOf(' ');
  return i > 0 ? {
    verb: cmd.slice(0, i),
    arg: JSON.parse(cmd.slice(i + 1))
  } : {
    verb: cmd,
    arg: undefined
  }
}

// create a new array with newCmd appended to cmdList 
// and all commands of type newCmd filtered out of cmdList,
// since those should be unnecessary  
function addCommand(cmdList, newCmd) {
  const newCmdList = filterMatchingCommandType(cmdList, newCmd);

  newCmdList.push(newCmd);
  
  return newCmdList;
}

function addCommandList(cmdList, newCmdList) {
  let result = [];
  for (const newCmd of newCmdList) {
    result = addCommand(cmdList, newCmd);
  }

  return result;
}

function filterMatchingCommandType(cmdList, newCmd) {
  return cmdList.filter(
    cmd => {
      return !(cmd.op === newCmd.op && cmd.path === newCmd.path);
      // return true;
    }
  );
}

// including value
function filterMatchingCommand(cmdList, newCmd) {
  return cmdList.filter(
    cmd => {
      return !(cmd.op === newCmd.op && cmd.path === newCmd.path && cmd.value === newCmd.value);
    }
  );
}

function filterMatchingCommandList(cmdList, newCmdList) {
  
  let result = [...cmdList];

  for (const newCmd of newCmdList) {
    result = filterMatchingCommand(result, newCmd);
  }

  return result;
}