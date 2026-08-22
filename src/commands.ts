import { ApplicationCommandType, ApplicationIntegrationType, InteractionContextType, PermissionFlagsBits, type RESTPutAPIApplicationCommandsJSONBody } from "discord-api-types/v10";

export const commands = [
    {
        name: "config",
        description: "Setup and configure the report channel or other bot settings.",
        type: ApplicationCommandType.ChatInput,
        default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
        integration_types: [ApplicationIntegrationType.GuildInstall],
        contexts: [InteractionContextType.Guild],
    },
    {
        name: "report",
        description: "Send a report to the server moderators.",
        type: ApplicationCommandType.ChatInput,
        integration_types: [ApplicationIntegrationType.GuildInstall],
        contexts: [InteractionContextType.Guild],
    },
    {
        name: "Report Message",
        type: ApplicationCommandType.Message,
        integration_types: [ApplicationIntegrationType.GuildInstall],
        contexts: [InteractionContextType.Guild],
    },
    {
        name: "Report User",
        type: ApplicationCommandType.User,
        integration_types: [ApplicationIntegrationType.GuildInstall],
        contexts: [InteractionContextType.Guild],
    },
] satisfies RESTPutAPIApplicationCommandsJSONBody;