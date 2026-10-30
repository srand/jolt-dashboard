import React from 'react';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';

class Attribution extends React.Component {
    render() {
        const value = this.props.value || '';
        let isLink = false;
        // Require an absolute URL; URL alone also accepts malformed slash forms.
        if (!this.props.textOnly && /^https?:\/\/[^/]/i.test(value) && !/[\s\\]/.test(value) &&
            !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
            try {
                const url = new URL(value);
                isLink = (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
            } catch {
                // Invalid URLs remain plain text, like all other attribution.
            }
        }

        return (
            <Box
                component="span"
                title={value || undefined}
                sx={this.props.compact ? {
                    display: 'block',
                    minWidth: 0,
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                } : { whiteSpace: 'nowrap' }}
            >
                {isLink ? (
                    <Link href={value} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>
                        {value}
                    </Link>
                ) : value}
            </Box>
        );
    }
}

export default Attribution;
