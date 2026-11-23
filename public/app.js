
        // ==================== CONFIGURATION ====================
        const WS_URL = window.location.protocol === 'https:' ? `wss://${window.location.host}` : `ws://${window.location.host}`;
        let ws = null;
        let localStream = null;
        let screenStream = null;
        let screenAudioTrack = null;
        let peerConnections = new Map();
        let currentRoomId = null;
        let userId = null;
        let userName = null;
        let isScreenSharing = false;

        // DOM elements
        const joinScreen = document.getElementById('joinScreen');
        const meetingUI = document.getElementById('meetingUI');
        const videoGrid = document.getElementById('videoGrid');
        const displayRoomCode = document.getElementById('displayRoomCode');
        const copyCodeBtn = document.getElementById('copyCodeBtn');
        const fullscreenBtn = document.getElementById('fullscreenBtn');
        const micBtn = document.getElementById('micBtn');
        const camBtn = document.getElementById('camBtn');
        const screenBtn = document.getElementById('screenBtn');
        const leaveBtn = document.getElementById('leaveBtn');
        const joinBtn = document.getElementById('joinBtn');
        const createBtn = document.getElementById('createBtn');
        const roomCodeInput = document.getElementById('roomCode');
        const usernameInput = document.getElementById('usernameInput');
        const participantCountSpan = document.getElementById('participantCount');

        // TURN servers
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                {
                    urls: 'turn:openrelay.metered.ca:80',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                },
                {
                    urls: 'turn:openrelay.metered.ca:443',
                    username: 'openrelayproject',
                    credential: 'openrelayproject'
                }
            ]
        };

        // Focus mode state
        let isFocusMode = false;
        let focusedVideoId = null;

        // ==================== UTILITIES ====================
        function showToast(msg, duration = 3000) {
            const existing = document.querySelector('.toast');
            if (existing) existing.remove();
            const toast = document.createElement('div');
            toast.className = 'toast';
            toast.textContent = msg;
            document.body.appendChild(toast);
            setTimeout(() => toast.remove(), duration);
        }

        function generateUserId() { return Math.random().toString(36).substring(2,10) + Date.now().toString(36); }
        function generateRoomCode() { return Math.random().toString(36).substring(2,10).toUpperCase(); }

        // ==================== VIDEO CARD CONTROLS ====================
        function addVideoCardControls(card, videoId, videoElement) {
            const buttonContainer = document.createElement('div');
            buttonContainer.className = 'video-card-buttons';
            
            const focusBtn = document.createElement('button');
            focusBtn.className = 'video-action-btn';
            focusBtn.innerHTML = '⭐';
            focusBtn.title = 'Focus this video';
            focusBtn.onclick = (e) => {
                e.stopPropagation();
                if (isFocusMode && focusedVideoId === videoId) exitFocusMode();
                else enterFocusMode(videoId);
            };
            
            const fullscreenCardBtn = document.createElement('button');
            fullscreenCardBtn.className = 'video-action-btn';
            fullscreenCardBtn.innerHTML = '⛶';
            fullscreenCardBtn.title = 'Fullscreen';
            fullscreenCardBtn.onclick = (e) => {
                e.stopPropagation();
                if (videoElement.requestFullscreen) {
                    videoElement.requestFullscreen();
                } else if (videoElement.webkitRequestFullscreen) {
                    videoElement.webkitRequestFullscreen();
                } else {
                    showToast('Fullscreen not supported');
                }
            };
            
            buttonContainer.appendChild(focusBtn);
            buttonContainer.appendChild(fullscreenCardBtn);
            card.appendChild(buttonContainer);
        }

        function enterFocusMode(videoId) {
            if (isFocusMode) exitFocusMode();
            focusedVideoId = videoId;
            isFocusMode = true;
            videoGrid.classList.add('focus-mode');
            const focusedCard = document.getElementById(videoId);
            if (focusedCard) focusedCard.classList.add('focused');
            
            const exitBtn = document.createElement('button');
            exitBtn.id = 'exitFocusBtn';
            exitBtn.className = 'exit-focus-btn';
            exitBtn.innerHTML = '✖️ Exit Focus';
            exitBtn.onclick = () => exitFocusMode();
            meetingUI.appendChild(exitBtn);
        }

        function exitFocusMode() {
            if (!isFocusMode) return;
            isFocusMode = false;
            videoGrid.classList.remove('focus-mode');
            const focusedCard = document.getElementById(focusedVideoId);
            if (focusedCard) focusedCard.classList.remove('focused');
            const exitBtn = document.getElementById('exitFocusBtn');
            if (exitBtn) exitBtn.remove();
            focusedVideoId = null;
        }

        // ==================== PERSISTENCE ====================
        function saveMeetingState(roomId, name) {
            if (roomId && name) {
                localStorage.setItem('meetstream_room', roomId);
                localStorage.setItem('meetstream_name', name);
            } else {
                localStorage.removeItem('meetstream_room');
                localStorage.removeItem('meetstream_name');
            }
        }

        function loadSavedState() {
            const savedRoom = localStorage.getItem('meetstream_room');
            const savedName = localStorage.getItem('meetstream_name');
            if (savedRoom && savedName) {
                setTimeout(() => startMeeting(savedRoom, savedName, true), 500);
            }
        }

        // ==================== WEBRTC & SIGNALING ====================
        function connectWebSocket(roomId, userId, userName) {
            return new Promise((resolve, reject) => {
                ws = new WebSocket(WS_URL);
                ws.onopen = () => {
                    console.log('WebSocket connected');
                    ws.send(JSON.stringify({ type: 'join-room', roomId, userId, userName }));
                    resolve();
                };
                ws.onmessage = async (event) => {
                    const data = JSON.parse(event.data);
                    console.log('Received message:', data.type);
                    await handleSignalingMessage(data);
                };
                ws.onerror = (err) => reject(err);
                ws.onclose = () => showToast('Disconnected from server');
            });
        }

        async function handleSignalingMessage(data) {
            switch (data.type) {
                case 'user-joined':
                    console.log(`User joined: ${data.userName} (${data.userId})`);
                    await createPeerConnection(data.participantId, data.userId, data.userName, true);
                    break;
                case 'existing-participants':
                    console.log(`Existing participants: ${data.participants.length}`);
                    for (const p of data.participants) {
                        await createPeerConnection(p.participantId, p.userId, p.userName, false);
                    }
                    updateParticipantCount();
                    break;
                case 'offer':
                    await handleOffer(data);
                    break;
                case 'answer':
                    await handleAnswer(data);
                    break;
                case 'ice-candidate':
                    await handleIceCandidate(data);
                    break;
                case 'user-left':
                    console.log(`User left: ${data.userName}`);
                    removePeerConnection(data.userId);
                    updateParticipantCount();
                    showToast(`${data.userName || 'User'} left`);
                    break;
            }
        }

        async function createPeerConnection(participantId, remoteUserId, remoteUserName, isInitiator) {
            if (peerConnections.has(remoteUserId)) return;
            console.log(`Creating peer connection for ${remoteUserName} (initiator: ${isInitiator})`);
            const pc = new RTCPeerConnection(configuration);
            peerConnections.set(remoteUserId, { pc, participantId, userName: remoteUserName });

            if (localStream) {
                localStream.getTracks().forEach(track => {
                    pc.addTrack(track, localStream);
                });
            }

            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    ws.send(JSON.stringify({
                        type: 'ice-candidate',
                        from: userId,
                        to: remoteUserId,
                        data: { candidate: event.candidate }
                    }));
                }
            };

            pc.ontrack = (event) => {
                console.log(`Received remote track from ${remoteUserName}, kind: ${event.track.kind}`);
                addRemoteVideo(remoteUserId, remoteUserName, event.streams[0]);
            };

            pc.onconnectionstatechange = () => {
                console.log(`Connection state for ${remoteUserName}: ${pc.connectionState}`);
                if (pc.connectionState === 'connected') {
                    console.log(`✅ Connected to ${remoteUserName}`);
                } else if (pc.connectionState === 'failed') {
                    console.error(`❌ Connection failed to ${remoteUserName}`);
                    removePeerConnection(remoteUserId);
                }
            };

            if (isInitiator) {
                console.log(`Creating offer for ${remoteUserName}`);
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                ws.send(JSON.stringify({
                    type: 'offer',
                    from: userId,
                    to: remoteUserId,
                    data: { sdp: pc.localDescription }
                }));
            }
        }

        async function handleOffer(data) {
            const peer = peerConnections.get(data.from);
            if (!peer) return;
            console.log(`Handling offer from ${data.from}`);
            await peer.pc.setRemoteDescription(new RTCSessionDescription(data.data.sdp));
            const answer = await peer.pc.createAnswer();
            await peer.pc.setLocalDescription(answer);
            ws.send(JSON.stringify({
                type: 'answer',
                from: userId,
                to: data.from,
                data: { sdp: peer.pc.localDescription }
            }));
        }

        async function handleAnswer(data) {
            const peer = peerConnections.get(data.from);
            if (!peer) return;
            console.log(`Handling answer from ${data.from}`);
            if (peer.pc.remoteDescription === null) {
                await peer.pc.setRemoteDescription(new RTCSessionDescription(data.data.sdp));
            }
        }

        async function handleIceCandidate(data) {
            const peer = peerConnections.get(data.from);
            if (peer && data.data.candidate) {
                try {
                    await peer.pc.addIceCandidate(new RTCIceCandidate(data.data.candidate));
                } catch (err) {
                    console.error('Error adding ICE candidate:', err);
                }
            }
        }

        function addRemoteVideo(userId, userName, stream) {
            let card = document.getElementById(`video-${userId}`);
            if (!card) {
                console.log(`Creating video element for ${userName}`);
                card = document.createElement('div');
                card.className = 'video-card';
                card.id = `video-${userId}`;
                const video = document.createElement('video');
                video.id = `remote-${userId}`;
                video.autoplay = true;
                video.playsInline = true;
                const nameSpan = document.createElement('div');
                nameSpan.className = 'participant-name';
                nameSpan.textContent = userName || `User ${userId.slice(0,4)}`;
                card.appendChild(video);
                card.appendChild(nameSpan);
                addVideoCardControls(card, `video-${userId}`, video);
                videoGrid.appendChild(card);
            }
            const videoElem = card.querySelector('video');
            if (videoElem.srcObject !== stream) {
                videoElem.srcObject = stream;
                videoElem.play().catch(e => console.warn('Play failed:', e));
                console.log(`Attached remote stream for ${userName}`);
            }
        }

        function removePeerConnection(userId) {
            const peer = peerConnections.get(userId);
            if (peer) {
                peer.pc.close();
                peerConnections.delete(userId);
            }
            const card = document.getElementById(`video-${userId}`);
            if (card) card.remove();
            if (isFocusMode && focusedVideoId === `video-${userId}`) exitFocusMode();
        }

        // ==================== MEDIA & SCREEN SHARE WITH AUDIO ====================
        async function setupLocalMedia() {
            try {
                localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
                console.log('Local stream obtained');
                const localCard = document.createElement('div');
                localCard.className = 'video-card';
                localCard.id = 'local-video';
                const video = document.createElement('video');
                video.id = 'localVideo';
                video.autoplay = true;
                video.playsInline = true;
                video.muted = true;
                video.srcObject = localStream;
                const nameSpan = document.createElement('div');
                nameSpan.className = 'participant-name';
                nameSpan.textContent = `${userName} (You)`;
                localCard.appendChild(video);
                localCard.appendChild(nameSpan);
                addVideoCardControls(localCard, 'local-video', video);
                videoGrid.insertBefore(localCard, videoGrid.firstChild);
                micBtn.classList.remove('mic-off');
                camBtn.classList.remove('cam-off');
                return true;
            } catch (err) {
                console.error('Media error:', err);
                showToast('Please allow camera and microphone access');
                return false;
            }
        }

        // Show a dialog to ask for audio preference
        function showScreenShareDialog() {
            return new Promise((resolve) => {
                const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
                if (isMobile) {
                    showToast('Screen sharing is not supported on mobile browsers');
                    resolve(null);
                    return;
                }
                const dialog = document.createElement('div');
                dialog.className = 'share-dialog';
                dialog.innerHTML = `
                    <h3 style="margin:0">Share your screen</h3>
                    <label>
                        <input type="checkbox" id="shareAudioCheckbox"> 🎵 Share device audio (movie sound)
                    </label>
                    <div style="display:flex; gap:12px; justify-content:center;">
                        <button class="confirm-btn">Start Sharing</button>
                        <button class="cancel-btn">Cancel</button>
                    </div>
                `;
                document.body.appendChild(dialog);
                const confirmBtn = dialog.querySelector('.confirm-btn');
                const cancelBtn = dialog.querySelector('.cancel-btn');
                const checkbox = dialog.querySelector('#shareAudioCheckbox');
                
                const cleanup = () => dialog.remove();
                confirmBtn.onclick = () => {
                    const wantAudio = checkbox.checked;
                    cleanup();
                    resolve(wantAudio);
                };
                cancelBtn.onclick = () => {
                    cleanup();
                    resolve(null);
                };
                // close on outside click?
            });
        }

        async function startScreenShare() {
            if (isScreenSharing) {
                stopScreenShare();
                return;
            }
            const wantAudio = await showScreenShareDialog();
            if (wantAudio === null) return; // cancelled
            
            try {
                const constraints = { video: true };
                if (wantAudio) constraints.audio = true;
                
                screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
                const screenVideoTrack = screenStream.getVideoTracks()[0];
                const screenAudio = screenStream.getAudioTracks()[0];
                
                // Build new outgoing stream: keep mic audio + screen video + (optional) screen audio
                const newStream = new MediaStream();
                // Keep existing mic audio (we don't replace microphone, we add screen audio as extra)
                localStream.getAudioTracks().forEach(track => newStream.addTrack(track));
                newStream.addTrack(screenVideoTrack);
                if (screenAudio) {
                    newStream.addTrack(screenAudio);
                    screenAudioTrack = screenAudio;
                    showToast('🎵 Sharing device audio (movie sound)');
                }
                
                // Replace video track in all peer connections, and possibly add screen audio track
                for (const [_, peer] of peerConnections) {
                    // Replace video
                    const videoSender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
                    if (videoSender) await videoSender.replaceTrack(screenVideoTrack);
                    else peer.pc.addTrack(screenVideoTrack, newStream);
                    
                    // If we have screen audio, replace/add audio track (the mic audio is already present)
                    // But we want to send both mic and screen audio? Actually we need to replace the audio track
                    // with the screen audio if we want only screen audio? No, we want both mic and screen audio.
                    // The user can mute mic separately. So we need to add a second audio track? That's not allowed.
                    // Better: We'll replace the mic track with a combined stream? That's complex.
                    // Simpler: For audio, we'll replace the mic track with the screen audio track, and the user can mute
                    // their mic if they don't want to talk. That's the simplest. So we replace the existing audio track
                    // with the screen audio track. That way others hear the movie sound, and the user can optionally
                    // mute their mic (by clicking mic button) if they want only the movie.
                    // So we'll replace the audio track.
                    if (screenAudio) {
                        const audioSender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
                        if (audioSender) await audioSender.replaceTrack(screenAudio);
                        else peer.pc.addTrack(screenAudio, newStream);
                    }
                }
                
                // Stop old video track (camera) and replace localStream
                const oldVideo = localStream.getVideoTracks()[0];
                if (oldVideo) oldVideo.stop();
                localStream = newStream;
                
                // Update local video preview
                const localVideo = document.getElementById('localVideo');
                if (localVideo) localVideo.srcObject = localStream;
                
                screenVideoTrack.onended = () => stopScreenShare();
                isScreenSharing = true;
                screenBtn.classList.add('screen-active');
                
                // Show badge on local video card
                const localCard = document.getElementById('local-video');
                if (localCard) {
                    let audioBadge = localCard.querySelector('.screen-audio-badge');
                    if (!audioBadge && screenAudio) {
                        audioBadge = document.createElement('div');
                        audioBadge.className = 'participant-name screen-audio-badge';
                        audioBadge.style.bottom = '40px';
                        audioBadge.style.background = '#10b981';
                        audioBadge.innerHTML = '🎵 Audio';
                        localCard.appendChild(audioBadge);
                    }
                }
                
                showToast(wantAudio ? 'Screen sharing started with audio' : 'Screen sharing started');
            } catch (err) {
                console.error('Screen share error:', err);
                showToast('Screen share cancelled or not supported');
            }
        }

        async function stopScreenShare() {
            if (!isScreenSharing) return;
            
            // Get fresh camera stream
            const cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
            const cameraVideoTrack = cameraStream.getVideoTracks()[0];
            
            // Create new stream: camera video + mic audio (keep mic)
            const newStream = new MediaStream();
            // Keep original mic audio (we saved the mic track? Actually localStream currently contains the screen audio track, so we need to restore mic.
            // We'll need to store the mic track when screen sharing starts. Let's store micTrack globally.
            // For simplicity, we'll just get a fresh mic track.
            const freshMic = await navigator.mediaDevices.getUserMedia({ audio: true });
            const micTrack = freshMic.getAudioTracks()[0];
            newStream.addTrack(micTrack);
            newStream.addTrack(cameraVideoTrack);
            
            // Replace video and audio in all peer connections
            for (const [_, peer] of peerConnections) {
                const videoSender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
                if (videoSender) await videoSender.replaceTrack(cameraVideoTrack);
                else peer.pc.addTrack(cameraVideoTrack, newStream);
                
                const audioSender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
                if (audioSender) await audioSender.replaceTrack(micTrack);
                else peer.pc.addTrack(micTrack, newStream);
            }
            
            // Stop screen share tracks
            if (screenStream) {
                screenStream.getTracks().forEach(t => t.stop());
                screenStream = null;
            }
            if (screenAudioTrack) screenAudioTrack = null;
            
            localStream = newStream;
            
            // Update local preview
            const localVideo = document.getElementById('localVideo');
            if (localVideo) localVideo.srcObject = localStream;
            
            isScreenSharing = false;
            screenBtn.classList.remove('screen-active');
            
            // Remove audio badge
            const localCard = document.getElementById('local-video');
            if (localCard) {
                const badge = localCard.querySelector('.screen-audio-badge');
                if (badge) badge.remove();
            }
            showToast('Screen sharing stopped');
        }

        function updateParticipantCount() {
            const count = peerConnections.size + 1;
            participantCountSpan.innerHTML = `👥 ${count} participant${count !== 1 ? 's' : ''}`;
        }

        async function leaveMeeting() {
            if (localStream) {
                localStream.getTracks().forEach(t => t.stop());
                localStream = null;
            }
            if (screenStream) {
                screenStream.getTracks().forEach(t => t.stop());
                screenStream = null;
            }
            for (const [_, peer] of peerConnections) {
                peer.pc.close();
            }
            peerConnections.clear();
            if (ws) {
                ws.send(JSON.stringify({ type: 'leave-room', userName }));
                ws.close();
            }
            videoGrid.innerHTML = '';
            joinScreen.style.display = 'flex';
            meetingUI.style.display = 'none';
            saveMeetingState(null, null);
            exitFocusMode();
            showToast('You left the meeting');
        }

        async function startMeeting(roomId, displayName, isAutoJoin = false) {
            currentRoomId = roomId;
            userId = generateUserId();
            userName = displayName;
            displayRoomCode.textContent = roomId;
            const mediaOk = await setupLocalMedia();
            if (!mediaOk) return;
            await connectWebSocket(roomId, userId, userName);
            joinScreen.style.display = 'none';
            meetingUI.style.display = 'flex';
            if (!isAutoJoin) {
                saveMeetingState(roomId, displayName);
                showToast(`Welcome, ${userName}!`);
            } else {
                showToast(`Rejoined meeting ${roomId}`);
            }
        }

        // ==================== MEDIA CONTROLS (camera/mic) ====================
        async function toggleCamera() {
            if (!localStream) return;
            const videoTrack = localStream.getVideoTracks()[0];
            if (videoTrack && videoTrack.enabled) {
                videoTrack.stop();
                localStream.removeTrack(videoTrack);
                camBtn.classList.add('cam-off');
                showToast('Camera off');
            } else {
                try {
                    const newStream = await navigator.mediaDevices.getUserMedia({ video: true });
                    const newVideoTrack = newStream.getVideoTracks()[0];
                    const oldVideo = localStream.getVideoTracks()[0];
                    if (oldVideo) localStream.removeTrack(oldVideo);
                    localStream.addTrack(newVideoTrack);
                    const localVideo = document.getElementById('localVideo');
                    if (localVideo) {
                        const newCombined = new MediaStream();
                        localStream.getTracks().forEach(t => newCombined.addTrack(t));
                        localVideo.srcObject = newCombined;
                        localStream = newCombined;
                    }
                    for (const [_, peer] of peerConnections) {
                        const sender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
                        if (sender) {
                            await sender.replaceTrack(newVideoTrack);
                        } else {
                            peer.pc.addTrack(newVideoTrack, localStream);
                        }
                    }
                    camBtn.classList.remove('cam-off');
                    showToast('Camera on');
                } catch (err) {
                    showToast('Could not access camera');
                }
            }
        }

        async function toggleMic() {
            if (!localStream) return;
            const audioTrack = localStream.getAudioTracks()[0];
            if (audioTrack && audioTrack.enabled) {
                audioTrack.stop();
                localStream.removeTrack(audioTrack);
                micBtn.classList.add('mic-off');
                showToast('Microphone off');
            } else {
                try {
                    const newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    const newAudioTrack = newStream.getAudioTracks()[0];
                    const oldAudio = localStream.getAudioTracks()[0];
                    if (oldAudio) localStream.removeTrack(oldAudio);
                    localStream.addTrack(newAudioTrack);
                    for (const [_, peer] of peerConnections) {
                        const sender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
                        if (sender) {
                            await sender.replaceTrack(newAudioTrack);
                        } else {
                            peer.pc.addTrack(newAudioTrack, localStream);
                        }
                    }
                    micBtn.classList.remove('mic-off');
                    showToast('Microphone on');
                } catch (err) {
                    showToast('Could not access microphone');
                }
            }
        }

        async function toggleScreenShareWithAudio() {
            if (isScreenSharing) {
                await stopScreenShare();
            } else {
                // Start screen share with audio
                const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
                if (isMobile) {
                    showToast('Screen sharing is not supported on mobile browsers');
                    return;
                }
                try {
                    const constraints = { video: true, audio: true };
                    screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
                    const screenVideoTrack = screenStream.getVideoTracks()[0];
                    const screenAudio = screenStream.getAudioTracks()[0];
                    
                    // Build new outgoing stream: keep mic audio + screen video + screen audio
                    const newStream = new MediaStream();
                    localStream.getAudioTracks().forEach(track => newStream.addTrack(track));
                    newStream.addTrack(screenVideoTrack);
                    if (screenAudio) {
                        newStream.addTrack(screenAudio);
                        screenAudioTrack = screenAudio;
                        showToast('🎵 Sharing device audio (movie sound)');
                    }
                    
                    // Replace video track in all peer connections, and replace audio with screen audio
                    for (const [_, peer] of peerConnections) {
                        const videoSender = peer.pc.getSenders().find(s => s.track?.kind === 'video');
                        if (videoSender) await videoSender.replaceTrack(screenVideoTrack);
                        else peer.pc.addTrack(screenVideoTrack, newStream);
                        
                        if (screenAudio) {
                            const audioSender = peer.pc.getSenders().find(s => s.track?.kind === 'audio');
                            if (audioSender) await audioSender.replaceTrack(screenAudio);
                            else peer.pc.addTrack(screenAudio, newStream);
                        }
                    }
                    
                    const oldVideo = localStream.getVideoTracks()[0];
                    if (oldVideo) oldVideo.stop();
                    localStream = newStream;
                    
                    const localVideo = document.getElementById('localVideo');
                    if (localVideo) localVideo.srcObject = localStream;
                    
                    screenVideoTrack.onended = () => stopScreenShare();
                    isScreenSharing = true;
                    screenBtn.classList.add('screen-active');
                    
                    const localCard = document.getElementById('local-video');
                    if (localCard) {
                        let audioBadge = localCard.querySelector('.screen-audio-badge');
                        if (!audioBadge && screenAudio) {
                            audioBadge = document.createElement('div');
                            audioBadge.className = 'participant-name screen-audio-badge';
                            audioBadge.style.bottom = '40px';
                            audioBadge.style.background = '#10b981';
                            audioBadge.innerHTML = '🎵 Audio';
                            localCard.appendChild(audioBadge);
                        }
                    }
                    showToast('Screen sharing started with audio');
                } catch (err) {
                    console.error('Screen share error:', err);
                    showToast('Screen share cancelled or not supported');
                }
            }
        }

        // ==================== EVENT LISTENERS ====================
        createBtn.onclick = () => {
            const name = usernameInput.value.trim();
            if (!name) { showToast('Please enter your name'); usernameInput.focus(); return; }
            startMeeting(generateRoomCode(), name);
        };
        joinBtn.onclick = () => {
            const name = usernameInput.value.trim();
            const code = roomCodeInput.value.trim().toUpperCase();
            if (!name) { showToast('Please enter your name'); usernameInput.focus(); return; }
            if (!code) { showToast('Please enter a meeting code'); roomCodeInput.focus(); return; }
            startMeeting(code, name);
        };
        copyCodeBtn.onclick = () => {
            navigator.clipboard.writeText(currentRoomId);
            showToast('Meeting code copied!');
        };
        fullscreenBtn.onclick = () => {
            if (!document.fullscreenElement) {
                meetingUI.requestFullscreen();
                fullscreenBtn.innerHTML = '📴 Exit';
            } else {
                document.exitFullscreen();
                fullscreenBtn.innerHTML = '🖥️ Fullscreen';
            }
        };
        document.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) fullscreenBtn.innerHTML = '📴 Exit';
            else fullscreenBtn.innerHTML = '🖥️ Fullscreen';
        });
        micBtn.onclick = toggleMic;
        camBtn.onclick = toggleCamera;
        screenBtn.onclick = () => {
            if (isScreenSharing) stopScreenShare();
            else startScreenShare();
        };
        leaveBtn.onclick = leaveMeeting;
        usernameInput.addEventListener('keypress', e => { if (e.key === 'Enter') createBtn.click(); });
        roomCodeInput.addEventListener('keypress', e => { if (e.key === 'Enter') joinBtn.click(); });

        // Keyboard shortcuts for mic (1) and camera (2)
        document.addEventListener('keydown', (event) => {
            // Prevent default only if the key is "1" or "2" and no input/textarea is focused
            const target = event.target;
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
            if (!isInput) {
                switch (event.key) {
                    case '1':
                        event.preventDefault();
                        toggleMic();
                        break;
                    case '2':
                        event.preventDefault();
                        toggleCamera();
                        break;
                    case '3':
                        event.preventDefault();
                        toggleScreenShareWithAudio();
                        break;
                }
            }
        });
        
        loadSavedState();
    