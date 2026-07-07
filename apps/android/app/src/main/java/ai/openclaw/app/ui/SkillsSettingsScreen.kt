package ai.openclaw.app.ui

import ai.openclaw.app.GatewayClawHubSkillSearchState
import ai.openclaw.app.GatewayClawHubSkillSummary
import ai.openclaw.app.GatewayClawHubInstallReview
import ai.openclaw.app.GatewaySkillSummary
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.ui.design.ClawDetailRow
import ai.openclaw.app.ui.design.ClawListPanel
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPrimaryButton
import ai.openclaw.app.ui.design.ClawSecondaryButton
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTextBadge
import ai.openclaw.app.ui.design.ClawTextField
import ai.openclaw.app.ui.design.ClawTheme
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** Settings screen for gateway skills and their readiness state. */
@Composable
internal fun SkillsSettingsScreen(
  viewModel: MainViewModel,
  onBack: () -> Unit,
) {
  val skillsSummary by viewModel.skillsSummary.collectAsState()
  val skillsRefreshing by viewModel.skillsRefreshing.collectAsState()
  val skillsErrorText by viewModel.skillsErrorText.collectAsState()
  val skillMutationKeys by viewModel.skillMutationKeys.collectAsState()
  val clawHubSearchState by viewModel.clawHubSkillSearchState.collectAsState()
  val isConnected by viewModel.isConnected.collectAsState()
  val skills = skillsSummary.skills
  val readyCount = skills.count { skillReady(it) }
  val needsSetupCount = skills.count { skillNeedsSetup(it) }
  val disabledCount = skills.count { it.disabled }
  var selectedSkillKey by remember { mutableStateOf<String?>(null) }
  var installedSearch by rememberSaveable { mutableStateOf("") }
  var statusFilter by rememberSaveable { mutableStateOf(SKILL_STATUS_FILTER_ALL) }
  var clawHubQuery by rememberSaveable { mutableStateOf("") }
  val visibleSkills =
    remember(skills, installedSearch, statusFilter) {
      skills
        .filter { skillMatchesStatus(it, statusFilter) }
        .filter { skillMatchesSearch(it, installedSearch) }
    }

  LaunchedEffect(isConnected) {
    if (isConnected) {
      viewModel.refreshSkills()
    }
  }

  selectedSkillKey?.let { skillKey ->
    val selectedSkill = skills.firstOrNull { it.skillKey == skillKey }
    SkillDetailSettingsScreen(
      skill = selectedSkill,
      skillKey = skillKey,
      isConnected = isConnected,
      isMutating = skillKey in skillMutationKeys,
      onSkillEnabledChange = viewModel::setSkillEnabled,
      onBack = { selectedSkillKey = null },
    )
    return
  }

  SettingsDetailFrame(
    title = "Skills",
    subtitle = "Manage installed skills and add new skills from ClawHub.",
    icon = Icons.Default.Settings,
    onBack = onBack,
  ) {
    SettingsMetricPanel(
      rows =
        listOf(
          SettingsMetric("Installed", skills.size.toString()),
          SettingsMetric("Ready", readyCount.toString()),
          SettingsMetric("Needs Setup", needsSetupCount.toString()),
          SettingsMetric("Off", disabledCount.toString()),
        ),
    )
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      ClawSecondaryButton(
        text = if (skillsRefreshing) "Refreshing" else "Refresh",
        onClick = viewModel::refreshSkills,
        enabled = isConnected && !skillsRefreshing,
        modifier = Modifier.weight(1f),
      )
    }
    skillsErrorText?.let { errorText ->
      ClawPanel {
        Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
    }
    SkillStatusFilterPanel(
      selected = statusFilter,
      counts =
        mapOf(
          SKILL_STATUS_FILTER_ALL to skills.size,
          SKILL_STATUS_FILTER_READY to readyCount,
          SKILL_STATUS_FILTER_NEEDS_SETUP to needsSetupCount,
          SKILL_STATUS_FILTER_DISABLED to disabledCount,
        ),
      onSelectedChange = { statusFilter = it },
    )
    InstalledSkillSearchPanel(
      query = installedSearch,
      onQueryChange = { installedSearch = it },
      visibleCount = visibleSkills.size,
      totalCount = skills.size,
    )
    when {
      !isConnected ->
        ClawPanel {
          Text(text = "Connect the gateway to load and manage skills.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      skills.isEmpty() ->
        ClawPanel {
          Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(text = "No skills installed.", style = ClawTheme.type.section, color = ClawTheme.colors.text)
            Text(text = "Search ClawHub below to install skills on the connected gateway.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
          }
        }
      visibleSkills.isEmpty() ->
        ClawPanel {
          Text(text = "No installed skills match this search.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        }
      else ->
        SkillsPanel(
          skills = visibleSkills,
          isConnected = isConnected,
          mutatingSkillKeys = skillMutationKeys,
          onSkillClick = { selectedSkillKey = it.skillKey },
          onSkillEnabledChange = viewModel::setSkillEnabled,
        )
    }
    ClawHubSkillSearchPanel(
      state = clawHubSearchState,
      query = clawHubQuery,
      isConnected = isConnected,
      onQueryChange = { clawHubQuery = it },
      onSearch = { viewModel.searchClawHubSkills(clawHubQuery) },
      onInstall = viewModel::reviewClawHubSkillInstall,
      onAcknowledgeInstall = { slug, version ->
        viewModel.installClawHubSkill(
          slug = slug,
          acknowledgeClawHubRisk = true,
          version = version,
        )
      },
      onClearMessage = viewModel::clearClawHubSkillSearchMessage,
    )
  }
  clawHubSearchState.installReview?.let { review ->
    ClawHubInstallReviewDialog(
      review = review,
      onDismiss = viewModel::dismissClawHubSkillInstallReview,
      onInstall = {
        viewModel.dismissClawHubSkillInstallReview()
        viewModel.installClawHubSkill(
          slug = review.slug,
          acknowledgeClawHubRisk = review.requiresRiskAcknowledgement,
          version = review.version,
        )
      },
    )
  }
}

@Composable
private fun ClawHubInstallReviewDialog(
  review: GatewayClawHubInstallReview,
  onDismiss: () -> Unit,
  onInstall: () -> Unit,
) {
  AlertDialog(
    onDismissRequest = onDismiss,
    title = { Text(text = "Review ClawHub audit") },
    text = {
      Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
          text = "ClawHub returned this review before download. Install only if the result matches your risk tolerance.",
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
        )
        ReviewLine(label = "Skill", value = "${review.displayName} (${review.slug})")
        ReviewLine(label = "Version", value = review.version)
        ReviewLine(label = "Author", value = review.author)
        ReviewLine(label = "Safety", value = review.safetyLabel)
        Text(text = review.safetyDetail, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
        review.securityAuditUrl?.let { url ->
          Text(text = "Security report: $url", style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        }
        if (review.blocked) {
          Text(
            text = "This release is blocked by ClawHub and will not be downloaded.",
            style = ClawTheme.type.body,
            color = ClawTheme.colors.warning,
          )
        }
      }
    },
    confirmButton = {
      if (!review.blocked) {
        TextButton(onClick = onInstall) {
          Text(text = if (review.requiresRiskAcknowledgement) "Acknowledge and install" else "Install")
        }
      }
    },
    dismissButton = {
      TextButton(onClick = onDismiss) {
        Text(text = if (review.blocked) "Close" else "Cancel")
      }
    },
  )
}

@Composable
private fun ReviewLine(
  label: String,
  value: String,
) {
  Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
    Text(text = label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    Text(text = value, style = ClawTheme.type.body, color = ClawTheme.colors.text)
  }
}

@Composable
private fun SkillStatusFilterPanel(
  selected: String,
  counts: Map<String, Int>,
  onSelectedChange: (String) -> Unit,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(text = "Status", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        SKILL_STATUS_FILTERS.forEach { filter ->
          val count = counts[filter.id] ?: 0
          val text = "${filter.label} $count"
          if (selected == filter.id) {
            ClawPrimaryButton(
              text = text,
              onClick = { onSelectedChange(filter.id) },
              modifier = Modifier.weight(1f),
            )
          } else {
            ClawSecondaryButton(
              text = text,
              onClick = { onSelectedChange(filter.id) },
              modifier = Modifier.weight(1f),
            )
          }
        }
      }
    }
  }
}

@Composable
private fun SkillDetailSettingsScreen(
  skill: GatewaySkillSummary?,
  skillKey: String,
  isConnected: Boolean,
  isMutating: Boolean,
  onSkillEnabledChange: (String, Boolean) -> Unit,
  onBack: () -> Unit,
) {
  BackHandler(onBack = onBack)

  SettingsDetailFrame(
    title = skill?.name ?: skillKey,
    subtitle = "Inspect and manage installed skill state.",
    icon = Icons.Default.Settings,
    onBack = onBack,
  ) {
    skill?.let { summary ->
      SettingsMetricPanel(
        rows =
          listOf(
            SettingsMetric("Status", skillStatusText(summary)),
            SettingsMetric("Source", skillSourceLabel(summary)),
            SettingsMetric("Missing", summary.missingCount.toString()),
          ),
      )
      SkillSwitchPanel(
        skill = summary,
        isConnected = isConnected,
        isMutating = isMutating,
        onSkillEnabledChange = onSkillEnabledChange,
      )
      SkillSetupPanel(summary)
    }
    SkillDetailPanel(skill = skill, isConnected = isConnected)
  }
}

@Composable
private fun InstalledSkillSearchPanel(
  query: String,
  onQueryChange: (String) -> Unit,
  visibleCount: Int,
  totalCount: Int,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
      ) {
        Text(text = "Installed skills", style = ClawTheme.type.section, color = ClawTheme.colors.text, modifier = Modifier.weight(1f))
        ClawStatusPill(text = "$visibleCount/$totalCount", status = ClawStatus.Neutral)
      }
      ClawTextField(value = query, onValueChange = onQueryChange, placeholder = "Search installed skills")
    }
  }
}

@Composable
private fun SkillSwitchPanel(
  skill: GatewaySkillSummary,
  isConnected: Boolean,
  isMutating: Boolean,
  onSkillEnabledChange: (String, Boolean) -> Unit,
) {
  ClawPanel {
    Row(
      modifier = Modifier.fillMaxWidth(),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(text = "Gateway switch", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = skillSwitchText(skill), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
      Switch(
        checked = !skill.disabled,
        onCheckedChange = { onSkillEnabledChange(skill.skillKey, it) },
        enabled = isConnected && !isMutating,
      )
    }
  }
}

@Composable
private fun SkillSetupPanel(skill: GatewaySkillSummary) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
      Text(text = "Setup", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = skillConfigurationText(skill), style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
  }
}

@Composable
private fun SkillDetailPanel(
  skill: GatewaySkillSummary?,
  isConnected: Boolean,
) {
  if (!isConnected) {
    ClawPanel {
      Text(text = "Connect the gateway to load skill details.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
    return
  }
  if (skill == null) {
    ClawPanel {
      Text(text = "Skill detail is not available in the current skills status.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
    }
    return
  }
  SettingsMetricPanel(
    rows =
      listOf(
        SettingsMetric("Skill Key", skill.skillKey),
        SettingsMetric("Display", skill.name),
        SettingsMetric("Source", skillSourceLabel(skill)),
        SettingsMetric("Install Options", skill.installCount.toString()),
      ),
  )
  skill.description?.let { description ->
    ClawPanel {
      Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(text = "Description", style = ClawTheme.type.section, color = ClawTheme.colors.text)
        Text(text = description, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    }
  }
}

@Composable
private fun SkillsPanel(
  skills: List<GatewaySkillSummary>,
  isConnected: Boolean,
  mutatingSkillKeys: Set<String>,
  onSkillClick: (GatewaySkillSummary) -> Unit,
  onSkillEnabledChange: (String, Boolean) -> Unit,
) {
  ClawListPanel(items = skills) { skill ->
    SkillListRow(
      skill = skill,
      isConnected = isConnected,
      isMutating = skill.skillKey in mutatingSkillKeys,
      onClick = { onSkillClick(skill) },
      onSkillEnabledChange = onSkillEnabledChange,
    )
  }
}

@Composable
private fun SkillListRow(
  skill: GatewaySkillSummary,
  isConnected: Boolean,
  isMutating: Boolean,
  onClick: () -> Unit,
  onSkillEnabledChange: (String, Boolean) -> Unit,
) {
  ClawDetailRow(
    title = skill.name,
    subtitle = skillSubtitle(skill),
    modifier = Modifier.clickable(onClickLabel = "Open skill detail", onClick = onClick),
    leading = { ClawTextBadge(text = skillBadge(skill)) },
    trailing = {
      Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        ClawStatusPill(text = skillStatusText(skill), status = skillStatus(skill))
        Switch(
          checked = !skill.disabled,
          onCheckedChange = { onSkillEnabledChange(skill.skillKey, it) },
          enabled = isConnected && !isMutating,
        )
        Icon(
          imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
          contentDescription = null,
          tint = ClawTheme.colors.textSubtle,
        )
      }
    },
  )
}

@Composable
private fun ClawHubSkillSearchPanel(
  state: GatewayClawHubSkillSearchState,
  query: String,
  isConnected: Boolean,
  onQueryChange: (String) -> Unit,
  onSearch: () -> Unit,
  onInstall: (GatewayClawHubSkillSummary) -> Unit,
  onAcknowledgeInstall: (String, String?) -> Unit,
  onClearMessage: () -> Unit,
) {
  ClawPanel {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
      Text(text = "ClawHub", style = ClawTheme.type.section, color = ClawTheme.colors.text)
      Text(text = "Search the registry and install skills onto the connected gateway.", style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      ClawTextField(value = query, onValueChange = onQueryChange, placeholder = "Search ClawHub skills")
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        ClawPrimaryButton(
          text = if (state.searching) "Searching" else "Search ClawHub",
          onClick = onSearch,
          enabled = isConnected && !state.searching,
          modifier = Modifier.weight(1f),
        )
        ClawSecondaryButton(
          text = "Clear",
          onClick = onClearMessage,
          enabled = state.errorText != null || state.messageText != null,
          modifier = Modifier.weight(0.7f),
        )
      }
      state.errorText?.let { errorText ->
        Text(text = errorText, style = ClawTheme.type.body, color = ClawTheme.colors.warning)
      }
      state.acknowledgeSlug?.let { slug ->
        ClawSecondaryButton(
          text = "Acknowledge risk and install",
          onClick = { onAcknowledgeInstall(slug, state.acknowledgeVersion) },
          enabled = isConnected && slug !in state.installingSlugs,
        )
      }
      state.messageText?.let { messageText ->
        Text(text = messageText, style = ClawTheme.type.body, color = ClawTheme.colors.textMuted)
      }
    }
  }
  if (state.results.isNotEmpty()) {
    ClawListPanel(items = state.results) { result ->
      ClawHubSkillRow(
        result = result,
        isConnected = isConnected,
        reviewing = result.slug == state.reviewingSlug,
        installing = result.slug in state.installingSlugs,
        onInstall = onInstall,
      )
    }
  }
}

@Composable
private fun ClawHubSkillRow(
  result: GatewayClawHubSkillSummary,
  isConnected: Boolean,
  reviewing: Boolean,
  installing: Boolean,
  onInstall: (GatewayClawHubSkillSummary) -> Unit,
) {
  ClawDetailRow(
    title = result.displayName,
    subtitle = clawHubSkillSubtitle(result),
    leading = { ClawTextBadge(text = "CH") },
    trailing = {
      ClawSecondaryButton(
        text = when {
          reviewing -> "Reviewing"
          installing -> "Installing"
          else -> "Install"
        },
        onClick = { onInstall(result) },
        enabled = isConnected && !reviewing && !installing,
      )
    },
  )
}

private fun skillReady(skill: GatewaySkillSummary): Boolean =
  !skill.disabled &&
    skill.eligible &&
    !skillBlocked(skill) &&
    skill.missingCount == 0

private fun skillBlocked(skill: GatewaySkillSummary): Boolean = skill.blockedByAllowlist || skill.blockedByAgentFilter

private fun skillNeedsSetup(skill: GatewaySkillSummary): Boolean =
  !skill.disabled &&
    (skillBlocked(skill) || !skill.eligible || skill.missingCount > 0)

private fun skillMatchesStatus(
  skill: GatewaySkillSummary,
  statusFilter: String,
): Boolean =
  when (statusFilter) {
    SKILL_STATUS_FILTER_READY -> skillReady(skill)
    SKILL_STATUS_FILTER_NEEDS_SETUP -> skillNeedsSetup(skill)
    SKILL_STATUS_FILTER_DISABLED -> skill.disabled
    else -> true
  }

private fun skillStatusText(skill: GatewaySkillSummary): String =
  when {
    skill.disabled -> "Off"
    skillBlocked(skill) -> "Blocked"
    skillNeedsSetup(skill) -> "Setup"
    else -> "Ready"
  }

private fun skillStatus(skill: GatewaySkillSummary): ClawStatus =
  when {
    skill.disabled -> ClawStatus.Neutral
    skillNeedsSetup(skill) -> ClawStatus.Warning
    else -> ClawStatus.Success
  }

private fun skillSubtitle(skill: GatewaySkillSummary): String {
  val issue =
    when {
      skill.disabled -> "Disabled"
      skill.blockedByAllowlist -> "Allowlist blocked"
      skill.blockedByAgentFilter -> "Agent filter blocked"
      skill.missingCount > 0 -> "${skill.missingCount} missing"
      !skill.eligible -> "Needs setup"
      else -> null
    }
  return listOfNotNull(skill.description, skillSourceLabel(skill), issue).joinToString(" · ")
}

private fun skillSwitchText(skill: GatewaySkillSummary): String =
  if (skill.disabled) {
    "Turn this skill on globally for the gateway."
  } else {
    "Turn this skill off globally without uninstalling it."
  }

private fun skillConfigurationText(skill: GatewaySkillSummary): String =
  when {
    skill.disabled -> "This skill is disabled on the gateway. Turn it on from this screen when you want OpenClaw to use it."
    skill.blockedByAllowlist -> "This skill is blocked by the gateway allowlist. The global switch can still be managed here."
    skill.blockedByAgentFilter -> "This skill is blocked by the current agent skill filter. The global switch can still be managed here."
    skill.missingCount > 0 -> "This skill needs ${skill.missingCount} setup item(s) before it can run."
    !skill.eligible -> "This skill is installed but not currently eligible to run."
    else -> "Ready on this gateway."
  }

private fun skillSourceLabel(skill: GatewaySkillSummary): String =
  when (skill.source) {
    "openclaw-bundled" -> if (skill.bundled) "Built-in" else "Bundled"
    "openclaw-managed" -> "Installed"
    "openclaw-workspace" -> "Workspace"
    "openclaw-extra" -> "Extra"
    else -> "Skill"
  }

private fun skillMatchesSearch(
  skill: GatewaySkillSummary,
  query: String,
): Boolean {
  val normalized = query.trim().lowercase()
  if (normalized.isEmpty()) return true
  return listOf(skill.name, skill.skillKey, skill.description.orEmpty(), skill.source)
    .any { it.lowercase().contains(normalized) }
}

private fun clawHubSkillSubtitle(result: GatewayClawHubSkillSummary): String =
  listOfNotNull(
    result.summary,
    result.version?.let { "v$it" },
    result.slug,
  ).joinToString(" · ")

private fun skillBadge(skill: GatewaySkillSummary): String {
  skill.emoji?.let { return it }
  return skill.name
    .split(' ', '-', '_')
    .filter { it.isNotBlank() }
    .take(2)
    .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
    .joinToString("")
    .ifBlank { "S" }
}

private const val SKILL_STATUS_FILTER_ALL = "all"
private const val SKILL_STATUS_FILTER_READY = "ready"
private const val SKILL_STATUS_FILTER_NEEDS_SETUP = "needs-setup"
private const val SKILL_STATUS_FILTER_DISABLED = "disabled"

private data class SkillStatusFilterOption(
  val id: String,
  val label: String,
)

private val SKILL_STATUS_FILTERS =
  listOf(
    SkillStatusFilterOption(SKILL_STATUS_FILTER_ALL, "All"),
    SkillStatusFilterOption(SKILL_STATUS_FILTER_READY, "Ready"),
    SkillStatusFilterOption(SKILL_STATUS_FILTER_NEEDS_SETUP, "Setup"),
    SkillStatusFilterOption(SKILL_STATUS_FILTER_DISABLED, "Off"),
  )
