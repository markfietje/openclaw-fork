import OpenClawChatUI
import SwiftUI

struct TalkProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @AppStorage("talk.enabled") private var talkEnabled: Bool = false
    @AppStorage(TalkSpeechLocale.storageKey) private var talkSpeechLocale: String = TalkSpeechLocale.automaticID
    @AppStorage(TalkDefaults.speakerphoneEnabledKey) private var talkSpeakerphoneEnabled: Bool =
        TalkDefaults.speakerphoneEnabledByDefault
    @AppStorage("talk.background.enabled") private var talkBackgroundEnabled: Bool = false
    @State private var showPermissionPrompt = false
    @State private var showTalkIssueDetails = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let ownsNavigationStack: Bool
    var openSettings: () -> Void
    var openVoiceSettings: () -> Void

    init(
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        ownsNavigationStack: Bool = true,
        openSettings: @escaping () -> Void,
        openVoiceSettings: (() -> Void)? = nil)
    {
        self.headerLeadingAction = headerLeadingAction
        self.ownsNavigationStack = ownsNavigationStack
        self.openSettings = openSettings
        self.openVoiceSettings = openVoiceSettings ?? openSettings
    }

    private var state: TalkProState {
        TalkProState(
            gatewayConnected: self.gatewayConnected,
            isDemoMode: self.appModel.isAppleReviewDemoModeEnabled,
            isEnabled: self.appModel.talkMode.isEnabled || self.talkEnabled,
            phase: self.appModel.talkMode.phase,
            isConfigLoaded: self.appModel.talkMode.gatewayTalkConfigLoaded,
            isListening: self.appModel.talkMode.isListening,
            isSpeaking: self.appModel.talkMode.isSpeaking,
            isUserSpeechDetected: self.appModel.talkMode.isUserSpeechDetected,
            permissionState: self.appModel.talkMode.gatewayTalkPermissionState)
    }

    var body: some View {
        Group {
            if self.ownsNavigationStack {
                NavigationStack {
                    self.content
                }
            } else {
                self.content
            }
        }
        .sheet(isPresented: self.$showPermissionPrompt) {
            NavigationStack {
                TalkPermissionPromptView(
                    style: .sheet,
                    onPermissionReady: {
                        self.showPermissionPrompt = false
                        self.startTalk()
                    })
                    .padding()
                    .navigationTitle("Enable Talk")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button {
                                self.showPermissionPrompt = false
                            } label: {
                                Text("Not Now")
                                    .font(OpenClawType.subheadSemiBold)
                            }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
            .openClawSheetChrome()
        }
        .sheet(isPresented: self.$showTalkIssueDetails) {
            if let fallbackIssue = self.fallbackIssue {
                TalkRuntimeIssueDetailsSheet(
                    issue: fallbackIssue,
                    onOpenSettings: self.openVoiceSettings)
                    .openClawSheetChrome()
            }
        }
        .onAppear { self.alignPersistedTalkState() }
    }

    private var content: some View {
        List {
            if let fallbackIssue = self.fallbackIssue {
                Section {
                    TalkRuntimeIssueBanner(
                        issue: fallbackIssue,
                        onOpenSettings: self.openVoiceSettings,
                        onShowDetails: {
                            self.showTalkIssueDetails = true
                        })
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            self.heroSection
            self.conversationSection
            self.voiceModeSection
            self.controlsSection
        }
        .navigationTitle("Talk")
        .toolbar {
            if let headerLeadingAction {
                ToolbarItem(placement: .topBarLeading) {
                    OpenClawSidebarRevealButton(action: headerLeadingAction)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            self.primaryActionBar
        }
    }

    private var heroSection: some View {
        Section {
            VStack(spacing: 18) {
                HStack {
                    Text("OPENCLAW VOICE")
                        .font(OpenClawType.monoSmall)
                        .foregroundStyle(OpenClawBrand.carapaceCoral)
                    Spacer()
                    Label {
                        Text(self.state.isEnabled ? "LIVE" : "STANDBY")
                            .font(OpenClawType.caption2Bold)
                    } icon: {
                        Circle()
                            .fill(self.state.isEnabled ? OpenClawBrand.carapaceSea : Color.secondary)
                            .frame(width: 6, height: 6)
                    }
                    .foregroundStyle(self.state.isEnabled ? OpenClawBrand.carapaceSea : Color.secondary)
                }

                TalkAvatarWaveformView(
                    phase: self.state.waveformPhase(
                        micLevel: self.appModel.talkMode.micLevel,
                        playbackLevel: self.appModel.talkMode.playbackLevel),
                    palette: .openClawBrand,
                    diameter: 124,
                    avatarDiameter: 74)
                {
                    Text(self.agentBadge)
                        .font(OpenClawType.avatar(size: self.agentBadge.count > 2 ? 27 : 38))
                        .foregroundStyle(.white)
                        .minimumScaleFactor(0.55)
                        .lineLimit(1)
                        .frame(width: 74, height: 74)
                        .background(Circle().fill(OpenClawBrand.carapaceElevated))
                }
                .frame(height: 124)
                .accessibilityHidden(true)

                VStack(spacing: 4) {
                    Text(self.state.title)
                        .font(OpenClawType.title3SemiBold)
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                    self.heroSubtitle
                        .font(OpenClawType.subhead)
                        .foregroundStyle(Color.white.opacity(0.72))
                        .multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 18)
            .padding(.vertical, 20)
            .background {
                ZStack {
                    OpenClawBrand.carapaceSurface
                    LinearGradient(
                        colors: [
                            OpenClawBrand.carapaceCoral.opacity(self.state.isEnabled ? 0.10 : 0.04),
                            .clear,
                            OpenClawBrand.carapaceSea.opacity(self.state.isEnabled ? 0.07 : 0.02),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing)
                }
            }
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(self.state.isEnabled ? OpenClawBrand.carapaceCoral : Color.white.opacity(0.08))
                    .frame(height: 1)
            }
            .animation(self.reduceMotion ? nil : .easeOut(duration: 0.2), value: self.state.isEnabled)
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
    }

    /// Voice is a persistent phone-level mode, so its control stays reachable
    /// beside the bottom navigation instead of scrolling away with diagnostics.
    private var primaryActionBar: some View {
        Button(action: self.handlePrimaryAction) {
            Label {
                Text(self.state.primaryButtonTitle)
                    .font(OpenClawType.subheadSemiBold)
            } icon: {
                Image(systemName: self.state.primaryButtonIcon)
            }
            // Match the icon to the label; otherwise the symbol picks up the tint color.
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
        }
        .buttonStyle(.borderedProminent)
        .tint(self.state.color)
        .disabled(self.state.primaryAction == .waiting)
        .accessibilityIdentifier("talk-primary-control")
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(.bar)
        .overlay(alignment: .top) {
            Divider()
        }
    }

    private var conversationSection: some View {
        Section("Conversation") {
            SettingsDetailRow("Agent", value: .verbatim(self.appModel.chatAgentName))
            SettingsDetailRow("Session", value: .verbatim(self.appModel.chatSessionKey))
            SettingsDetailRow("Runtime", value: .localized(self.appModel.talkMode.statusText))
        }
    }

    private var agentBadge: String {
        ChatProTab.normalizedBadgeEmoji(self.appModel.chatAgentAvatarText)
            ?? ChatProTab.initialsBadge(for: self.appModel.chatAgentName)
    }

    private var voiceModeSection: some View {
        Section("Voice Mode") {
            SettingsDetailRow(
                "Configured",
                value: .localized(self.appModel.talkMode.gatewayTalkVoiceModeTitle))
            SettingsDetailRow("Active", value: .verbatim(self.activeModeText))
            SettingsDetailRow("Transport", value: .localized(self.transportText))
            if let issueText = self.talkIssueText {
                SettingsDetailRow("Last issue", value: .verbatim(issueText))
            }
            SettingsDetailRow("Permission", value: .localized(self.permissionText))
            SettingsDetailRow("Speech language", value: .verbatim(self.speechLocaleText))
        }
    }

    private var controlsSection: some View {
        Section("Controls") {
            Toggle(isOn: self.talkSpeakerphoneBinding) {
                Text("Speakerphone")
                    .font(OpenClawType.body)
            }
            .accessibilityIdentifier("talk-speakerphone-control")
            Toggle(isOn: self.$talkBackgroundEnabled) {
                Text("Background listening")
                    .font(OpenClawType.body)
            }
            .accessibilityIdentifier("talk-background-listening-control")
            Button(action: self.openVoiceSettings) {
                HStack {
                    Label("Voice & Talk Settings", systemImage: "slider.horizontal.3")
                        .font(OpenClawType.body)
                        .foregroundStyle(.primary)
                    Spacer()
                    Image(systemName: "chevron.forward")
                        .font(OpenClawType.footnoteSemiBold)
                        .foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("talk-voice-settings-control")
        }
    }

    private var gatewayConnected: Bool {
        !self.appModel.isAppleReviewDemoModeEnabled &&
            GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var fallbackIssue: TalkRuntimeIssue? {
        guard self.gatewayConnected else { return nil }
        return self.appModel.talkMode.gatewayTalkCurrentFallbackIssue
    }

    @ViewBuilder
    private var heroSubtitle: some View {
        if self.state.prefersPermissionCopy {
            Text("Gateway approval is required before this phone can capture voice.")
                .font(OpenClawType.subhead)
        } else if self.appModel.isAppleReviewDemoModeEnabled {
            Text("Voice is disabled in Apple Review demo mode.")
                .font(OpenClawType.subhead)
        } else if !self.gatewayConnected {
            Text("Connect to your gateway to start a voice conversation.")
                .font(OpenClawType.subhead)
        } else if !self.appModel.talkMode.gatewayTalkConfigLoaded {
            Text("Open Voice settings after the gateway loads Talk configuration.")
                .font(OpenClawType.subhead)
        } else {
            let subtitle = (appModel.talkMode.gatewayTalkVoiceModeSubtitle ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if subtitle.isEmpty {
                Text(verbatim: String(
                    format: String(localized: "Routes voice to %@."),
                    self.appModel.chatAgentName))
                    .font(OpenClawType.subhead)
            } else {
                Text(verbatim: subtitle)
                    .font(OpenClawType.subhead)
            }
        }
    }

    private var transportText: String {
        let provider = self.appModel.talkMode.gatewayTalkProviderLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        let transport = self.appModel.talkMode.gatewayTalkTransportLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        if provider.isEmpty || provider == "Not loaded" { return transport.isEmpty ? "Not loaded" : transport }
        if transport.isEmpty || transport == "Not loaded" { return provider }
        return "\(provider) • \(transport)"
    }

    private var activeModeText: String {
        let title = self.appModel.talkMode.gatewayTalkActiveModeTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = (appModel.talkMode.gatewayTalkActiveModeSubtitle ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return String(localized: "Not active") }
        if subtitle.isEmpty { return title }
        return "\(title) • \(subtitle)"
    }

    private var talkIssueText: String? {
        let text = (appModel.talkMode.gatewayTalkLastIssueText ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private var permissionText: String {
        if let failure = appModel.talkMode.gatewayTalkPermissionState.failureMessage {
            return failure
        }
        return self.appModel.talkMode.gatewayTalkPermissionState.statusLabel
    }

    private var speechLocaleText: String {
        if self.talkSpeechLocale == TalkSpeechLocale.automaticID { return "Automatic" }
        return self.talkSpeechLocale
    }

    private func alignPersistedTalkState() {
        if self.appModel.isAppleReviewDemoModeEnabled,
           self.talkEnabled || self.appModel.talkMode.isEnabled
        {
            self.stopTalk()
        } else if self.appModel.talkMode.gatewayTalkPermissionState.requiresTalkPermissionAction,
                  self.talkEnabled || self.appModel.talkMode.isEnabled
        {
            self.stopTalk()
        } else if self.talkEnabled != self.appModel.talkMode.isEnabled {
            self.appModel.setTalkEnabled(self.talkEnabled)
        }
    }

    private var talkSpeakerphoneBinding: Binding<Bool> {
        Binding(
            get: { self.talkSpeakerphoneEnabled },
            set: { enabled in
                self.talkSpeakerphoneEnabled = enabled
                self.appModel.setTalkSpeakerphoneEnabled(enabled)
            })
    }

    private func handlePrimaryAction() {
        switch self.state.primaryAction {
        case .start:
            self.startTalk()
        case .stop:
            self.stopTalk()
        case .enablePermission:
            self.stopTalk()
            self.showPermissionPrompt = true
        case .openSettings:
            self.openPrimarySettings()
        case .waiting:
            break
        }
    }

    private func startTalk() {
        guard !self.appModel.isAppleReviewDemoModeEnabled else { return }
        self.talkEnabled = true
        self.appModel.synchronizeTalkSessionKey()
        self.appModel.setTalkEnabled(true)
    }

    private func stopTalk() {
        self.talkEnabled = false
        self.appModel.setTalkEnabled(false)
    }

    private func openPrimarySettings() {
        if self.gatewayConnected {
            self.openVoiceSettings()
        } else {
            self.openSettings()
        }
    }
}

enum TalkProPrimaryAction: Equatable {
    case start
    case stop
    case enablePermission
    case openSettings
    case waiting
}

extension TalkWaveformPalette {
    /// iOS app branding for the shared wave: adaptive accent front lobe plus
    /// system grays so the idle wave tracks light/dark appearance.
    static let openClawBrand = TalkWaveformPalette(
        active: [
            OpenClawBrand.carapaceCoral,
            OpenClawBrand.carapaceSea,
            OpenClawBrand.accent,
        ],
        inactive: [
            Color(uiColor: .systemGray2),
            Color(uiColor: .systemGray3),
            Color(uiColor: .systemGray4),
        ])
}

struct TalkProState: Equatable {
    let gatewayConnected: Bool
    let isDemoMode: Bool
    let isEnabled: Bool
    let phase: TalkPhase
    let isConfigLoaded: Bool
    let isListening: Bool
    let isSpeaking: Bool
    let isUserSpeechDetected: Bool
    let permissionState: TalkGatewayPermissionState

    var title: LocalizedStringResource {
        if self.isDemoMode { return "Demo mode only" }
        if !self.gatewayConnected { return "Gateway offline" }
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return "Gateway permission required"
        case .requestingUpgrade:
            return "Requesting approval"
        case .upgradeRequested:
            return "Approval requested"
        case .apiKeyMissing:
            return "Voice API key missing"
        case .loadFailed:
            return "Voice config failed"
        default:
            break
        }
        if !self.isConfigLoaded { return "Voice config unavailable" }
        if self.isSpeaking { return "Speaking" }
        if self.isListening { return "Listening" }
        if self.phase == .connecting { return "Connecting" }
        if self.phase == .thinking { return "Asking OpenClaw" }
        if self.isEnabled { return "Ready to talk" }
        return "Talk is off"
    }

    var color: Color {
        if self.isDemoMode { return .secondary }
        if !self.gatewayConnected { return .secondary }
        switch self.permissionState {
        case .requestFailed, .loadFailed:
            return OpenClawBrand.danger
        case .missingScope, .requestingUpgrade, .upgradeRequested, .apiKeyMissing:
            return OpenClawBrand.warn
        default:
            if !self.isConfigLoaded { return OpenClawBrand.warn }
            return self.isEnabled ? OpenClawBrand.ok : OpenClawBrand.accentHot
        }
    }

    var primaryAction: TalkProPrimaryAction {
        if self.isDemoMode { return .waiting }
        if !self.gatewayConnected { return .openSettings }
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return .enablePermission
        case .requestingUpgrade, .upgradeRequested:
            return .waiting
        case .apiKeyMissing, .loadFailed:
            return .openSettings
        default:
            return self.isEnabled ? .stop : .start
        }
    }

    var primaryButtonTitle: LocalizedStringResource {
        switch self.primaryAction {
        case .start: "Start Talk"
        case .stop: "Stop Talk"
        case .enablePermission: "Enable Talk"
        case .openSettings: self.gatewayConnected ? "Open Voice Settings" : "Open Gateway Settings"
        case .waiting: self.isDemoMode ? "Demo Mode Only" : "Waiting for Approval"
        }
    }

    var primaryButtonIcon: String {
        switch self.primaryAction {
        case .start: "play.fill"
        case .stop: "stop.fill"
        case .enablePermission: "key.fill"
        case .openSettings: "gearshape.fill"
        case .waiting: self.isDemoMode ? "lock.fill" : "hourglass"
        }
    }

    var prefersPermissionCopy: Bool {
        switch self.permissionState {
        case .missingScope, .requestingUpgrade, .upgradeRequested, .requestFailed:
            true
        default:
            false
        }
    }

    func waveformPhase(micLevel: Double, playbackLevel: Double?) -> TalkWaveformPhase {
        if self.isDemoMode { return .idle }
        if !self.gatewayConnected { return .idle }
        switch self.permissionState {
        case .requestingUpgrade, .upgradeRequested:
            return .thinking
        case .missingScope, .requestFailed, .apiKeyMissing, .loadFailed:
            return .idle
        default:
            break
        }
        if !self.isConfigLoaded { return .idle }
        if self.isSpeaking { return .speaking(level: playbackLevel) }
        if self.isListening { return .listening(level: micLevel, speechActive: self.isUserSpeechDetected) }
        if self.phase == .connecting || self.phase == .thinking {
            return .thinking
        }
        return self.isEnabled ? .thinking : .idle
    }
}
