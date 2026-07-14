import SwiftUI

#if !os(macOS)
import PhotosUI
#if canImport(UIKit)
import UIKit
#endif
#endif

struct CleanChatComposerSurface: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .background(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .fill(OpenClawChatTheme.composerField))
            .overlay(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        #else
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular, in: .rect(cornerRadius: self.cornerRadius))
        } else {
            content
                .background(
                    .regularMaterial,
                    in: RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        }
        #endif
    }
}

enum CleanChatComposerMetrics {
    static let controlHeight: CGFloat = 44
}

struct CompactChatAttachmentLabel: View {
    var body: some View {
        Image(systemName: "plus")
            .font(OpenClawChatTypography.display(size: 15, weight: .semibold, relativeTo: .subheadline))
            .foregroundStyle(.secondary)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }
}

struct OpenClawChatAttachmentsStrip: View {
    let attachments: [OpenClawPendingAttachment]
    let onRemove: @MainActor (OpenClawPendingAttachment.ID) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(self.attachments, id: \OpenClawPendingAttachment.id) { attachment in
                    HStack(spacing: 6) {
                        if let image = attachment.preview {
                            OpenClawPlatformImageFactory.image(image)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 22, height: 22)
                                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        } else if attachment.mimeType.hasPrefix("audio/") {
                            Image(systemName: "waveform")
                            Text("Voice note")
                                .font(OpenClawChatTypography.caption)
                            if let duration = attachment.durationSeconds {
                                Text(openClawVoiceNoteDurationLabel(duration))
                                    .font(OpenClawChatTypography.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else {
                            Image(systemName: "photo")
                            Text(attachment.fileName)
                                .font(OpenClawChatTypography.caption)
                                .lineLimit(1)
                        }

                        if attachment.preview != nil {
                            Text(attachment.fileName)
                                .font(OpenClawChatTypography.caption)
                                .lineLimit(1)
                        }

                        Button {
                            self.onRemove(attachment.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(OpenClawChatTheme.accent.opacity(0.08))
                    .clipShape(Capsule())
                }
            }
        }
    }
}

#if !os(macOS)
struct OpenClawChatAttachmentMenu: View {
    @Binding var pickerItems: [PhotosPickerItem]
    @Binding var showsFileImporter: Bool
    @Binding var showsCameraPicker: Bool
    let isAttachmentInputEnabled: Bool
    let onPickerItemsChanged: @MainActor ([PhotosPickerItem]) -> Void

    var body: some View {
        Menu {
            PhotosPicker(selection: self.$pickerItems, maxSelectionCount: 8, matching: .images) {
                Label {
                    Text("Photo Library")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "photo.on.rectangle")
                }
            }

            #if canImport(UIKit)
            Button {
                self.showsCameraPicker = true
            } label: {
                Label {
                    Text("Camera")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "camera")
                }
            }
            .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            #endif

            Button {
                self.showsFileImporter = true
            } label: {
                Label {
                    Text("Choose Image File")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: "folder")
                }
            }

        } label: {
            CompactChatAttachmentLabel()
        }
        .help("Add attachment")
        .accessibilityLabel("Add attachment")
        .accessibilityIdentifier("chat-attachment-picker")
        .buttonStyle(.plain)
        .disabled(!self.isAttachmentInputEnabled)
        .onChange(of: self.pickerItems) { _, items in
            self.onPickerItemsChanged(items)
        }
    }
}

#if canImport(UIKit)
struct OpenClawChatCameraPicker: UIViewControllerRepresentable {
    let onImage: @MainActor (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_: UIImagePickerController, context _: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let parent: OpenClawChatCameraPicker

        init(parent: OpenClawChatCameraPicker) {
            self.parent = parent
        }

        func imagePickerController(
            _: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any])
        {
            if let image = info[.originalImage] as? UIImage {
                self.parent.onImage(image)
            }
            self.parent.dismiss()
        }

        func imagePickerControllerDidCancel(_: UIImagePickerController) {
            self.parent.dismiss()
        }
    }
}
#endif
#endif

struct OpenClawChatDictationButton: View {
    let control: OpenClawChatDictationControl
    let onStart: @MainActor () -> Void

    var body: some View {
        Button {
            if self.control.isActive {
                self.control.finish()
            } else {
                self.onStart()
            }
        } label: {
            Image(systemName: self.control.isActive ? "stop.fill" : "mic")
                .font(OpenClawChatTypography.display(size: 17, weight: .medium, relativeTo: .body))
                .foregroundStyle(self.control.isActive ? OpenClawChatTheme.accent : .secondary)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!self.control.isAvailable && !self.control.isActive)
        .accessibilityLabel(self.control.isActive ? "Finish dictation" : "Dictate message")
        .accessibilityValue(self.control.isActive ? "Listening" : "Not listening")
        .accessibilityIdentifier("chat-dictation-control")
        .help(self.control.isActive ? "Finish dictation" : "Transcribe speech into the message")
    }
}
