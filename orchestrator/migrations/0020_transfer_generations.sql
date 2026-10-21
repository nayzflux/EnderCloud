CREATE TABLE player_transfer_generations (player_id uuid PRIMARY KEY, generation bigint NOT NULL CHECK (generation > 0));
ALTER TABLE transfer_command_players ADD COLUMN generation bigint NOT NULL DEFAULT 1;
ALTER TABLE transfer_command_players DROP CONSTRAINT transfer_command_players_state_check;
ALTER TABLE transfer_command_players ADD CONSTRAINT transfer_command_players_state_check CHECK (state IN ('PENDING', 'ARRIVED', 'LEFT', 'SUPERSEDED', 'ABANDONED'));
